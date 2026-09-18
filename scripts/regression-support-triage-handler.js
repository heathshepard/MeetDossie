#!/usr/bin/env node
'use strict';

/**
 * scripts/regression-support-triage-handler.js
 *
 * End-to-end regression for api/cron-support-ticket-triage.js — the whole
 * handler, not just the classifier (that's regression-support-ticket-triage.js).
 *
 * ZERO PRODUCTION ACCESS, ZERO POSSIBILITY OF MAIL.
 *   - Supabase is an in-memory PostgREST mock over 127.0.0.1.
 *   - globalThis.fetch is wrapped: anything addressed to api.resend.com or
 *     api.telegram.org is recorded and answered locally. The wrapper THROWS on
 *     any other non-loopback host, so a coding mistake cannot reach the real
 *     internet from this test.
 *
 * WHAT IT PINS DOWN
 *   1. Switch OFF (the shipped default) = no customer is ever emailed, while
 *      classification, dispatch and logging all still work.
 *   2. Switch ON + a fresh customer bug = exactly one email, recorded with the
 *      provider's own message id, and a fix queued as a branch-only task.
 *   3. Switch ON + Amanda's exact ticket = ZERO emails. This is the assertion
 *      that matters most in this file.
 *   4. The 18 real historical rows, replayed with the switch ON, produce zero
 *      emails — the backfill can't become a mailing list.
 *   5. Idempotency: running twice never sends a second acknowledgement.
 *   6. Flood guard, per-run cap, suppression list, and the sensitive-area
 *      auto-fix block all actually stop the thing they claim to stop.
 *
 * Run: node scripts/regression-support-triage-handler.js [--verbose]
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

const VERBOSE = process.argv.includes('--verbose');
const REPO = path.join(__dirname, '..');
const HANDLER_PATH = path.join(REPO, 'api', 'cron-support-ticket-triage.js');

const CRON_SECRET = 'test-cron-secret';
const HOURS = 3600 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

// ── PostgREST mock ─────────────────────────────────────────────────────────

function matchFilter(row, key, expr) {
  const val = row[key];
  const dec = (s) => decodeURIComponent(s);
  if (expr.startsWith('eq.')) return String(val) === dec(expr.slice(3));
  if (expr === 'is.null') return val === null || val === undefined;
  if (expr === 'not.is.null') return val !== null && val !== undefined;
  if (expr.startsWith('gte.')) return val != null && String(val) >= dec(expr.slice(4));
  if (expr.startsWith('lt.')) return val != null && String(val) < dec(expr.slice(3));
  if (expr.startsWith('in.(')) {
    const vals = dec(expr).slice(4, -1).split(',').map((v) => v.replace(/^"|"$/g, ''));
    return vals.includes(String(val));
  }
  return true;
}

function startMock(seed) {
  const db = {
    support_tickets: (seed.support_tickets || []).map((r) => ({ ...r })),
    support_triage_log: [],
    profiles: (seed.profiles || []).map((r) => ({ ...r })),
    ops_flags: (seed.ops_flags || []).map((r) => ({ ...r })),
    ops_action_log: [],
    agent_queue: (seed.agent_queue || []).map((r) => ({ ...r })),
    email_suppression_list: (seed.email_suppression_list || []).map((r) => ({ ...r })),
    email_events: (seed.email_events || []).map((r) => ({ ...r })),
    cron_runs: (seed.cron_runs || []).map((r) => ({ ...r })),
    alert_state: (seed.alert_state || []).map((r) => ({ ...r })),
  };
  let seq = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const table = url.pathname.replace('/rest/v1/', '').split('?')[0];
    if (!(table in db)) { res.writeHead(404).end('[]'); return; }

    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const params = url.searchParams;
      const filters = [];
      for (const [k, v] of params) {
        if (['select', 'order', 'limit', 'on_conflict', 'offset'].includes(k)) continue;
        filters.push([k, v]);
      }
      const applyFilters = (rows) => rows.filter((row) => filters.every(([k, v]) => {
        if (k.includes('->>')) {
          const [col, jkey] = k.split('->>');
          const nested = (row[col] || {})[jkey];
          return matchFilter({ [jkey]: nested }, jkey, v);
        }
        return matchFilter(row, k, v);
      }));

      if (req.method === 'GET') {
        let rows = applyFilters(db[table]);
        const order = params.get('order');
        if (order) {
          const [col, dir] = order.split('.');
          rows = rows.slice().sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1));
          if (dir === 'desc') rows.reverse();
        }
        const limit = params.get('limit');
        if (limit) rows = rows.slice(0, Number(limit));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(rows));
        return;
      }

      if (req.method === 'POST') {
        const payload = JSON.parse(body || '{}');
        const rows = Array.isArray(payload) ? payload : [payload];
        const inserted = [];
        for (const r of rows) {
          // Enforce the real UNIQUE(source, ticket_id) constraint — this is
          // the idempotency guarantee, so the mock must honour it or the
          // idempotency test proves nothing.
          if (table === 'support_triage_log') {
            const clash = db[table].find((x) => x.source === r.source && x.ticket_id === r.ticket_id);
            if (clash) {
              res.writeHead(409, { 'Content-Type': 'application/json' })
                .end(JSON.stringify({ code: '23505', message: 'duplicate key' }));
              return;
            }
            // And the anti-optimistic-flag CHECKs.
            if (r.ack_outcome === 'sent' && !r.ack_provider_message_id) {
              res.writeHead(400).end(JSON.stringify({ code: '23514', message: 'check violation' })); return;
            }
            if (r.fix_outcome === 'queued' && !r.agent_queue_id) {
              res.writeHead(400).end(JSON.stringify({ code: '23514', message: 'check violation' })); return;
            }
          }
          const row = { id: uuid(), created_at: new Date().toISOString(), ...r };
          db[table].push(row);
          inserted.push(row);
        }
        res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify(inserted));
        return;
      }

      if (req.method === 'PATCH') {
        const patch = JSON.parse(body || '{}');
        const rows = applyFilters(db[table]);
        for (const row of rows) {
          const merged = { ...row, ...patch };
          if (table === 'support_triage_log') {
            if (merged.ack_outcome === 'sent' && !merged.ack_provider_message_id) {
              res.writeHead(400).end(JSON.stringify({ code: '23514' })); return;
            }
            if (merged.fix_outcome === 'queued' && !merged.agent_queue_id) {
              res.writeHead(400).end(JSON.stringify({ code: '23514' })); return;
            }
          }
          Object.assign(row, patch);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(rows));
        return;
      }

      res.writeHead(405).end('[]');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, db, close: () => server.close() });
    });
  });
}

// ── Outbound interceptor. Nothing leaves this process. ────────────────────

const realFetch = globalThis.fetch;
const outbound = { emails: [], telegrams: [] };
let resendShouldFail = false;

globalThis.fetch = async function guardedFetch(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.includes('api.resend.com')) {
    const payload = JSON.parse((init && init.body) || '{}');
    outbound.emails.push(payload);
    if (resendShouldFail) {
      return new Response(JSON.stringify({ message: 'simulated provider failure' }), { status: 422 });
    }
    return new Response(JSON.stringify({ id: `resend-mock-${outbound.emails.length}` }), { status: 200 });
  }
  if (url.includes('api.telegram.org')) {
    outbound.telegrams.push(JSON.parse((init && init.body) || '{}'));
    return new Response(JSON.stringify({ ok: true, result: { message_id: outbound.telegrams.length } }), { status: 200 });
  }
  if (!/^https?:\/\/127\.0\.0\.1[:/]/.test(url)) {
    throw new Error(`TEST GUARD: refused outbound request to ${url}`);
  }
  return realFetch(input, init);
};

// ── Harness ────────────────────────────────────────────────────────────────

function purgeApiCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}api${path.sep}`)) delete require.cache[key];
  }
}

async function runCron({ seed, env = {} }) {
  const mock = await startMock(seed);
  outbound.emails.length = 0;
  outbound.telegrams.length = 0;

  const saved = { ...process.env };
  process.env.SUPABASE_URL = `http://127.0.0.1:${mock.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.TELEGRAM_BOT_TOKEN = 'test-bot';
  process.env.TELEGRAM_CHAT_ID = '123';
  process.env.TELEGRAM_CRON_NOTIFICATIONS = '1';
  delete process.env.SUPPORT_TRIAGE_DRY_RUN;
  delete process.env.RUST_SUPABASE_URL;
  delete process.env.RUST_SUPABASE_SERVICE_ROLE_KEY;
  Object.assign(process.env, env);

  purgeApiCache();
  const mod = require(HANDLER_PATH);
  const handler = mod.handler || mod;

  const captured = { status: 0, json: null };
  const res = {
    setHeader() {},
    status(code) { captured.status = code; return this; },
    json(payload) { captured.json = payload; return this; },
    end() { return this; },
  };
  await handler({ method: 'GET', headers: { authorization: `Bearer ${CRON_SECRET}` } }, res);

  const result = {
    status: captured.status,
    body: captured.json,
    db: mock.db,
    emails: outbound.emails.slice(),
    telegrams: outbound.telegrams.slice(),
  };
  mock.close();
  process.env = saved;
  return result;
}

// Re-runs the cron against the SAME mock db (for idempotency).
async function runAgainst(mock, env = {}) {
  outbound.emails.length = 0;
  const saved = { ...process.env };
  process.env.SUPABASE_URL = `http://127.0.0.1:${mock.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.TELEGRAM_BOT_TOKEN = 'test-bot';
  process.env.TELEGRAM_CHAT_ID = '123';
  process.env.TELEGRAM_CRON_NOTIFICATIONS = '1';
  Object.assign(process.env, env);
  purgeApiCache();
  const mod = require(HANDLER_PATH);
  const handler = mod.handler || mod;
  const captured = {};
  await handler(
    { method: 'GET', headers: { authorization: `Bearer ${CRON_SECRET}` } },
    { setHeader() {}, status(c) { captured.status = c; return this; }, json(p) { captured.json = p; return this; }, end() { return this; } },
  );
  process.env = saved;
  return { body: captured.json, emails: outbound.emails.slice() };
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const FLAG_ON = [{ key: 'ack_support_ticket', enabled: true, reason: 'test' }];
const FLAG_OFF = [{ key: 'ack_support_ticket', enabled: false, reason: 'test' }];

const FRESH_BUG = {
  id: '11111111-1111-4111-8111-111111111111',
  user_id: 'u-brittney', agent_email: 'brittney@setxrealty.com',
  ticket_type: 'bug', status: 'open', created_at: iso(1 * HOURS),
  message: 'The pre-contract and pre-listing columns have disappeared from my pipeline view.',
};
const AMANDA = {
  id: '503a1d1b-3c49-4a25-abe1-27eb94afd62f',
  user_id: 'u-amanda', agent_email: 'amanda@amandanuckles.com',
  ticket_type: 'bug', status: 'open', created_at: iso(1 * HOURS),
  message: 'How do I cancel my account?',
};
const AUTH_BUG = {
  id: '22222222-2222-4222-8222-222222222222',
  user_id: 'u-x', agent_email: 'someone@realty.com',
  ticket_type: 'bug', status: 'open', created_at: iso(1 * HOURS),
  message: "I can't log in — the password reset link says my token is invalid.",
};
const PROFILES = [
  { id: 'u-brittney', full_name: 'Brittney Jones', email: 'brittney@setxrealty.com' },
  { id: 'u-amanda', full_name: 'Amanda Nuckles', email: 'amanda@amandanuckles.com' },
  { id: 'u-x', full_name: 'Sam Rivera', email: 'someone@realty.com' },
];

let pass = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; if (VERBOSE) console.log(`  ok  ${name}`); }
  catch (err) { failures.push(`${name}\n      ${err.message}`); }
}

(async () => {
  console.log('\n=== support-triage handler regression (mock DB, no real mail) ===\n');

  // ── 1. Shipped default: switch OFF.
  console.log('--- 1. switch OFF (shipped default) ---');
  {
    const r = await runCron({ seed: { support_tickets: [FRESH_BUG], profiles: PROFILES, ops_flags: FLAG_OFF } });
    t('returns 200', () => assert.strictEqual(r.status, 200));
    t('ZERO emails sent', () => assert.strictEqual(r.emails.length, 0));
    t('ledger records skipped_disabled', () => {
      const row = r.db.support_triage_log[0];
      assert.strictEqual(row.ack_outcome, 'skipped_disabled', JSON.stringify(row.reasons));
    });
    t('ack body was still COMPOSED (so Heath can read what would go out)', () => {
      assert.ok(String(r.db.support_triage_log[0].ack_body || '').startsWith('Hey Brittney,'));
    });
    t('fix STILL dispatched with the switch off', () => {
      assert.strictEqual(r.db.support_triage_log[0].fix_outcome, 'queued');
      assert.strictEqual(r.db.agent_queue.length, 1);
    });
    t('queued task is branch-only, never merge/deploy', () => {
      const q = r.db.agent_queue[0];
      assert.strictEqual(q.metadata.no_merge, true);
      assert.strictEqual(q.metadata.no_deploy, true);
      assert.match(q.task_brief, /Do NOT merge to main/);
      assert.match(q.task_brief, /Do NOT deploy/);
    });
    t('queue signal_key matches cron-autonomous-loop so the two dedup', () => {
      assert.strictEqual(r.db.agent_queue[0].metadata.signal_key, `customer_bug:${FRESH_BUG.id}`);
    });
    t('blocked attempt is logged to ops_action_log', () => {
      assert.ok(r.db.ops_action_log.some((l) => l.decision === 'blocked_flag_off'));
    });
  }

  // ── 2. Switch ON, a genuine fresh bug.
  console.log('--- 2. switch ON, fresh customer bug ---');
  {
    const r = await runCron({ seed: { support_tickets: [FRESH_BUG], profiles: PROFILES, ops_flags: FLAG_ON } });
    t('exactly ONE email', () => assert.strictEqual(r.emails.length, 1));
    t('addressed to the customer', () => assert.deepStrictEqual(r.emails[0].to, ['brittney@setxrealty.com']));
    t('from Heath', () => assert.match(r.emails[0].from, /heath@meetdossie\.com/));
    t('greets by first name, signs off as Heath', () => {
      const html = r.emails[0].html;
      assert.match(html, /Hey Brittney,/);
      assert.match(html, /Thanks,.*Heath/s);
    });
    t('promises nothing', () => {
      const html = r.emails[0].html;
      assert.doesNotMatch(html, /fixed|resolved|deployed|24 hours|by (Friday|Monday|tomorrow)/i);
    });
    t('ledger says sent AND carries the provider message id', () => {
      const row = r.db.support_triage_log[0];
      assert.strictEqual(row.ack_outcome, 'sent');
      assert.ok(row.ack_provider_message_id, 'no provider message id recorded');
      assert.strictEqual(row.ack_provider, 'resend');
      assert.ok(row.ack_sent_at);
    });
    t('autonomous action logged with the real message id', () => {
      const l = r.db.ops_action_log.find((x) => x.decision === 'autonomous');
      assert.ok(l && l.metadata.resend_message_id);
    });
  }

  // ── 3. THE ONE THAT MATTERS.
  console.log('--- 3. switch ON + Amanda\'s exact ticket ---');
  {
    const r = await runCron({ seed: { support_tickets: [AMANDA], profiles: PROFILES, ops_flags: FLAG_ON } });
    t('ZERO emails — a departing customer is never auto-replied to', () => {
      assert.strictEqual(r.emails.length, 0, `sent: ${JSON.stringify(r.emails)}`);
    });
    t('classified cancellation despite ticket_type=bug', () => {
      assert.strictEqual(r.db.support_triage_log[0].ticket_class, 'cancellation');
    });
    t('routed heath_only', () => assert.strictEqual(r.db.support_triage_log[0].route, 'heath_only'));
    t('no ack body was even composed', () => assert.strictEqual(r.db.support_triage_log[0].ack_body, null));
    t('no agent was dispatched at her', () => assert.strictEqual(r.db.agent_queue.length, 0));
    t('Heath was told, and told WHY', () => {
      assert.strictEqual(r.telegrams.length, 1);
      assert.match(r.telegrams[0].text, /CANCELLATION REQUEST/);
      assert.match(r.telegrams[0].text, /cancellation request/i);
    });
    t('heath_notified_at reflects a real send', () => {
      assert.ok(r.db.support_triage_log[0].heath_notified_at);
    });
    t('block logged against ALWAYS_HEATH policy', () => {
      const l = r.db.ops_action_log.find((x) => x.decision === 'blocked_always_heath');
      assert.ok(l, 'no blocked_always_heath entry');
      assert.strictEqual(l.capability, 'pricing_demo_complaint_conversation');
    });
  }

  // ── 4. Sensitive area: acknowledged, never auto-fixed.
  console.log('--- 4. switch ON + a login bug (protected area) ---');
  {
    const r = await runCron({ seed: { support_tickets: [AUTH_BUG], profiles: PROFILES, ops_flags: FLAG_ON } });
    t('customer IS acknowledged', () => assert.strictEqual(r.emails.length, 1));
    t('but NO agent is dispatched at auth code', () => assert.strictEqual(r.db.agent_queue.length, 0));
    t('ledger records blocked_sensitive + the area', () => {
      const row = r.db.support_triage_log[0];
      assert.strictEqual(row.fix_outcome, 'blocked_sensitive');
      assert.ok(row.sensitive_areas.includes('auth'));
    });
    t('Heath gets the diagnosis, naming the tripwire', () => {
      assert.match(r.telegrams[0].text, /auth/);
      assert.match(r.telegrams[0].text, /No agent has been dispatched/);
    });
  }

  // ── 5. All 18 real historical rows, switch ON.
  console.log('--- 5. the 18 real rows replayed with the switch ON ---');
  {
    const REAL = require(path.join(REPO, 'scripts', '_fixtures-support-tickets-2026-09-18.json'));
    const r = await runCron({ seed: { support_tickets: REAL, profiles: PROFILES, ops_flags: FLAG_ON } });
    t('ZERO emails across all 18 historical rows', () => {
      assert.strictEqual(r.emails.length, 0, `would have mailed: ${JSON.stringify(r.emails.map((e) => e.to))}`);
    });
    t('every decision is recorded', () => {
      const open = REAL.filter((x) => ['open', 'new', 'in_progress'].includes(x.status));
      assert.strictEqual(r.db.support_triage_log.length, open.length);
    });
    t('no ack outcome is ever "sent"', () => {
      assert.ok(!r.db.support_triage_log.some((x) => x.ack_outcome === 'sent'));
    });
    if (VERBOSE) {
      for (const row of r.db.support_triage_log) {
        console.log(`      ${String(row.recipient_email || '(none)').padEnd(32)} ${row.ticket_class.padEnd(13)} ${row.route.padEnd(18)} ack=${row.ack_outcome}`);
      }
    }
  }

  // ── 6. Idempotency: run twice.
  console.log('--- 6. idempotency ---');
  {
    const mock = await startMock({ support_tickets: [FRESH_BUG], profiles: PROFILES, ops_flags: FLAG_ON });
    const first = await runAgainst(mock);
    const second = await runAgainst(mock);
    t('first run sends one', () => assert.strictEqual(first.emails.length, 1));
    t('second run sends ZERO — one ack per ticket, ever', () => assert.strictEqual(second.emails.length, 0));
    t('second run reports it as already processed', () => assert.strictEqual(second.body.stats.already_processed, 1));
    t('still exactly one ledger row', () => assert.strictEqual(mock.db.support_triage_log.length, 1));
    mock.close();
  }

  // ── 7. Backfill window.
  console.log('--- 7. age window ---');
  {
    const old = { ...FRESH_BUG, created_at: iso(72 * HOURS) };
    const r = await runCron({ seed: { support_tickets: [old], profiles: PROFILES, ops_flags: FLAG_ON } });
    t('a 3-day-old ticket is never mailed', () => assert.strictEqual(r.emails.length, 0));
    t('and says why, permanently', () => assert.strictEqual(r.db.support_triage_log[0].ack_outcome, 'skipped_stale'));
  }

  // ── 8. Flood guard.
  console.log('--- 8. flood guard ---');
  {
    const flood = Array.from({ length: 12 }, (_, i) => ({
      ...FRESH_BUG,
      id: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`,
      created_at: iso(10 * 60 * 1000),
    }));
    const r = await runCron({ seed: { support_tickets: flood, profiles: PROFILES, ops_flags: FLAG_ON } });
    t('12 tickets in an hour mails NOBODY', () => assert.strictEqual(r.emails.length, 0));
    t('flood is flagged', () => assert.strictEqual(r.body.stats.flooding, true));
    t('Heath is told the acks were halted', () => {
      assert.ok(r.telegrams.some((m) => /flood/i.test(m.text) && /HALTED/.test(m.text)));
    });
  }

  // ── 9. Per-run cap (below the flood threshold).
  console.log('--- 9. per-run cap ---');
  {
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...FRESH_BUG,
      id: `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`,
      agent_email: `agent${i}@realty.com`, user_id: null,
      created_at: iso((i + 1) * 60 * 60 * 1000),
    }));
    const r = await runCron({ seed: { support_tickets: many, profiles: [], ops_flags: FLAG_ON } });
    t('never exceeds the per-run cap of 5', () => assert.ok(r.emails.length <= 5, `sent ${r.emails.length}`));
    t('the rest are recorded as capped', () => {
      assert.ok(r.db.support_triage_log.some((x) => x.ack_outcome === 'skipped_capped'));
    });
  }

  // ── 10. Suppression list.
  console.log('--- 10. suppression list ---');
  {
    const r = await runCron({
      seed: {
        support_tickets: [FRESH_BUG], profiles: PROFILES, ops_flags: FLAG_ON,
        email_suppression_list: [{ email: 'brittney@setxrealty.com' }],
      },
    });
    t('an unsubscribed customer is never mailed', () => assert.strictEqual(r.emails.length, 0));
    t('recorded as suppressed', () => assert.strictEqual(r.db.support_triage_log[0].ack_outcome, 'skipped_suppressed'));
  }

  // ── 11. A failed send is never retried.
  console.log('--- 11. failed send ---');
  {
    resendShouldFail = true;
    const mock = await startMock({ support_tickets: [FRESH_BUG], profiles: PROFILES, ops_flags: FLAG_ON });
    const first = await runAgainst(mock);
    const second = await runAgainst(mock);
    resendShouldFail = false;
    t('one attempt made', () => assert.strictEqual(first.emails.length, 1));
    t('recorded as failed with the error', () => {
      const row = mock.db.support_triage_log[0];
      assert.strictEqual(row.ack_outcome, 'failed');
      assert.ok(row.ack_error);
    });
    t('NEVER retried — an unverified send may have landed', () => {
      assert.strictEqual(second.emails.length, 0);
    });
    mock.close();
  }

  // ── 12. Internal senders.
  console.log('--- 12. internal senders ---');
  {
    const internal = [
      { id: '55555555-5555-4555-8555-555555555551', agent_email: 'quinn@meetdossie.internal', ticket_type: 'quinn_sev1', status: 'open', created_at: iso(1 * HOURS), message: '[quinn-daily-audit] T08 failed: automap_stuck_count_30' },
      { id: '55555555-5555-4555-8555-555555555552', agent_email: 'demo2@meetdossie.com', ticket_type: 'bug', status: 'open', created_at: iso(1 * HOURS), message: 'nothing loads and everything is broken' },
    ];
    const r = await runCron({ seed: { support_tickets: internal, profiles: [], ops_flags: FLAG_ON } });
    t('no mail to internal addresses', () => assert.strictEqual(r.emails.length, 0));
    t('no Telegram noise from internal rows', () => assert.strictEqual(r.telegrams.length, 0));
    t('no agent dispatched at Quinn audit noise', () => assert.strictEqual(r.db.agent_queue.length, 0));
    t('recorded as internal', () => {
      assert.ok(r.db.support_triage_log.every((x) => x.ack_outcome === 'skipped_internal'));
    });
  }

  // ── 13. Dedup against the autonomous loop.
  console.log('--- 13. dedup against cron-autonomous-loop ---');
  {
    const r = await runCron({
      seed: {
        support_tickets: [FRESH_BUG], profiles: PROFILES, ops_flags: FLAG_ON,
        agent_queue: [{
          id: 'existing-queue-row', agent_name: 'carter', status: 'pending',
          metadata: { signal_key: `customer_bug:${FRESH_BUG.id}`, enqueued_by: 'autonomous-loop' },
        }],
      },
    });
    t('does not double-file a bug the loop already queued', () => {
      assert.strictEqual(r.db.agent_queue.length, 1);
      assert.strictEqual(r.db.support_triage_log[0].fix_outcome, 'deduped');
    });
    t('but the customer is still acknowledged', () => assert.strictEqual(r.emails.length, 1));
  }

  // ── 14. The alarm on the pipeline itself.
  //
  // A poller that dies quietly is the failure class this whole change exists
  // to fix, so the alarm gets tested like everything else rather than assumed.
  console.log('--- 14. silence alarm on the triage pipeline ---');
  {
    const SILENCE_PATH = path.join(REPO, 'api', '_lib', 'silence-alarm.js');
    const withAlarm = async (seed) => {
      const mock = await startMock(seed);
      const saved = { ...process.env };
      process.env.SUPABASE_URL = `http://127.0.0.1:${mock.port}`;
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
      purgeApiCache();
      const { checkSupportTriageSilence } = require(SILENCE_PATH);
      const out = await checkSupportTriageSilence();
      mock.close();
      process.env = saved;
      return out;
    };

    // Healthy: cron ran 10 minutes ago, every customer ticket is decided.
    const healthy = await withAlarm({
      cron_runs: [{ cron_name: 'cron-support-ticket-triage', last_run: iso(10 * 60 * 1000), last_status: 'ok' }],
      support_tickets: [FRESH_BUG],
      ops_flags: FLAG_OFF,
    });
    // FRESH_BUG is 1h old and the window is 2h, so nothing is overdue yet.
    t('healthy pipeline fires nothing', () => assert.deepStrictEqual(healthy, []));

    // The cron stopped.
    const stopped = await withAlarm({
      cron_runs: [{ cron_name: 'cron-support-ticket-triage', last_run: iso(9 * HOURS), last_status: 'ok' }],
      support_tickets: [], ops_flags: FLAG_OFF,
    });
    t('a stopped poller fires', () => {
      assert.ok(stopped.some((c) => c.key === 'support_triage_cron_stale'), JSON.stringify(stopped));
    });

    // Never ran at all.
    const never = await withAlarm({ cron_runs: [], support_tickets: [], ops_flags: FLAG_OFF });
    t('a never-deployed poller fires', () => {
      assert.ok(never.some((c) => c.key === 'support_triage_never_ran'));
    });

    // THE WORSE ONE: green telemetry, unhandled customers.
    const green = await withAlarm({
      cron_runs: [{ cron_name: 'cron-support-ticket-triage', last_run: iso(5 * 60 * 1000), last_status: 'ok' }],
      support_tickets: [{ ...FRESH_BUG, created_at: iso(6 * HOURS) }],
      ops_flags: FLAG_OFF,
    });
    t('green telemetry + an undecided customer ticket still fires', () => {
      const hit = green.find((c) => c.key === 'support_tickets_untriaged');
      assert.ok(hit, JSON.stringify(green));
      assert.strictEqual(hit.count, 1);
    });

    // Internal noise must never light the alarm permanently.
    const noisy = await withAlarm({
      cron_runs: [{ cron_name: 'cron-support-ticket-triage', last_run: iso(5 * 60 * 1000), last_status: 'ok' }],
      support_tickets: [
        { id: '66666666-6666-4666-8666-666666666661', agent_email: 'quinn@meetdossie.internal', ticket_type: 'quinn_sev1', status: 'open', created_at: iso(48 * HOURS), message: 'audit failed' },
        { id: '66666666-6666-4666-8666-666666666662', agent_email: 'demo2@meetdossie.com', ticket_type: 'bug', status: 'open', created_at: iso(48 * HOURS), message: 'broken' },
      ],
      ops_flags: FLAG_OFF,
    });
    t('Quinn/demo backlog never lights the alarm', () => {
      assert.ok(!noisy.some((c) => c.key === 'support_tickets_untriaged'), JSON.stringify(noisy));
    });
  }

  // ── Report
  console.log('');
  if (failures.length === 0) {
    console.log(`✅ PASS — ${pass} assertions, 0 failures.`);
    process.exit(0);
  }
  console.log(`❌ FAIL — ${pass} passed, ${failures.length} failed:\n`);
  for (const f of failures) console.log(`  • ${f}\n`);
  process.exit(1);
})().catch((err) => {
  console.error('\n💥 harness error:', err);
  process.exit(1);
});
