'use strict';

// api/cron-regression-suite.test.js
//
// Wiring coverage for the alert path, against the real handler with a stubbed
// network. The pure decision table lives in
// api/_lib/regression-alert-policy.test.js; this file covers the parts that
// only break in integration:
//
//   1. the row is inserted with Prefer: return=representation, so the id comes
//      back and can be patched (it used to be return=minimal — there was no
//      id, which is why alert_sent was never corrected)
//   2. alert_sent is PATCHED with what actually happened, on success, on
//      telegram-gate suppression, and on a telegram HTTP failure
//   3. a gate-suppressed send is recorded as alert_sent=false even though it
//      arrives as a 200 with ok:true
//
// Run: node --test api/cron-regression-suite.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const CRON_PATH = require.resolve('./cron-regression-suite.js');
const GATE_PATH = require.resolve('./_lib/telegram-gate.js');
const TELEMETRY_PATH = require.resolve('./_lib/cron-telemetry.js');
const POLICY_PATH = require.resolve('./_lib/regression-alert-policy.js');

const SUPABASE_URL = 'https://stub.supabase.test';

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
  });
}

/**
 * Run the handler once against a stubbed network.
 *
 * @param {object} opts
 * @param {Array}  opts.previousResults   what the "previous run" lookup returns
 * @param {string|null} opts.lastAlertRunAt  run_at of the last delivered alert
 * @param {'ok'|'suppressed'|'http_error'} opts.telegram
 */
async function runHandler(opts = {}) {
  const {
    previousResults = [],
    lastAlertRunAt = null,
    telegram = 'ok',
  } = opts;

  const calls = { inserts: [], patches: [], telegram: [] };

  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  process.env.CRON_SECRET = 'test-secret';
  process.env.SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  process.env.TELEGRAM_BOT_TOKEN = '123:ABC';
  process.env.TELEGRAM_CHAT_ID = '999';
  process.env.REGRESSION_BASE_URL = 'https://stub.meetdossie.test';
  // Worst case for the gate: the documented default, everything muted unless
  // the job is on the ALWAYS_ALLOW floor.
  delete process.env.TELEGRAM_CRON_NOTIFICATIONS;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = (init.method || 'GET').toUpperCase();

    // ---- Telegram --------------------------------------------------------
    if (url.includes('api.telegram.org')) {
      calls.telegram.push(init.body ? JSON.parse(init.body) : null);
      if (telegram === 'http_error') return json({ ok: false, description: 'Bad Request' }, 400);
      if (telegram === 'suppressed') {
        // Exactly the shape telegram-gate's fakeTelegramOk() returns: a 200
        // that looks like success and is not.
        return json({
          ok: true,
          delivered: false,
          suppressed: true,
          suppressed_by: 'telegram-gate',
          result: { message_id: 0, date: 1 },
        });
      }
      return json({ ok: true, result: { message_id: 7 } });
    }

    // ---- Supabase --------------------------------------------------------
    if (url.startsWith(SUPABASE_URL)) {
      const path = url.slice(SUPABASE_URL.length);

      if (path.startsWith('/rest/v1/regression_runs')) {
        if (method === 'POST') {
          const body = JSON.parse(init.body);
          calls.inserts.push({ body, prefer: (init.headers || {}).Prefer });
          return json([Object.assign({ id: 'run-uuid-1' }, body)], 201);
        }
        if (method === 'PATCH') {
          calls.patches.push({ path, body: JSON.parse(init.body) });
          return new Response(null, { status: 204 });
        }
        // GET: the last-delivered-alert lookup vs the previous-run lookup.
        if (path.includes('alert_sent=is.true')) {
          return json(lastAlertRunAt ? [{ run_at: lastAlertRunAt }] : []);
        }
        return json(previousResults.length ? [{ results: previousResults }] : []);
      }

      // cron_runs: empty for the suite's own lookups (forces every cron test
      // to FAIL, which guarantees a deterministic RED run). Telemetry POSTs
      // here too and is fail-soft.
      if (path.startsWith('/rest/v1/cron_runs')) {
        return method === 'POST' ? new Response(null, { status: 201 }) : json([]);
      }

      // Everything else the DB tier touches.
      return json([], 200, { 'content-range': '0-0/0' });
    }

    // ---- probed API endpoints -------------------------------------------
    if (url.includes('/api/founding-count')) {
      return json({ spots_taken: 11, spots_remaining: 14 });
    }
    return json({ ok: true });
  };

  // The gate patches globalThis.fetch at require time, so the stub must be in
  // place first and the modules must be freshly required each run.
  delete require.cache[CRON_PATH];
  delete require.cache[GATE_PATH];
  delete require.cache[TELEMETRY_PATH];
  delete require.cache[POLICY_PATH];

  try {
    const handler = require('./cron-regression-suite.js');
    const req = { headers: { 'x-vercel-cron': '1' } };
    let payload = null;
    const res = {
      status() { return this; },
      json(b) { payload = b; return this; },
    };
    await handler(req, res);
    return { payload, calls };
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    delete require.cache[CRON_PATH];
    delete require.cache[GATE_PATH];
    delete require.cache[TELEMETRY_PATH];
    delete require.cache[POLICY_PATH];
  }
}

// ---------------------------------------------------------------------------

test('the run row is inserted with return=representation so its id is readable', async () => {
  const { calls } = await runHandler();
  assert.equal(calls.inserts.length, 1);
  assert.equal(
    calls.inserts[0].prefer,
    'return=representation',
    'return=minimal gives no id, which is why alert_sent was never patched'
  );
  assert.equal(calls.inserts[0].body.alert_sent, false, 'still provisional at insert time');
  assert.equal(calls.inserts[0].body.notes, 'alert: pending');
});

test('a delivered alert patches alert_sent=true back onto the row', async () => {
  const { payload, calls } = await runHandler({ telegram: 'ok' });

  assert.equal(payload.alert_decision.alert, true, 'no previous run + failures => alert');
  assert.equal(calls.telegram.length, 1, 'exactly one Telegram send');
  assert.equal(payload.alert_sent, true);

  assert.equal(calls.patches.length, 1, 'the outcome must be written back');
  assert.match(calls.patches[0].path, /id=eq\.run-uuid-1/);
  assert.equal(calls.patches[0].body.alert_sent, true);
  assert.match(calls.patches[0].body.notes, /delivered/);
});

test('a gate-suppressed send records alert_sent=FALSE despite the fake 200/ok:true', async () => {
  const { payload, calls } = await runHandler({ telegram: 'suppressed' });

  // This is the whole point: res.ok was true and body.ok was true. The old
  // `return { sent: res.ok }` would have called this a delivery.
  assert.equal(payload.alert_sent, false);
  assert.equal(payload.alert_outcome.includes('suppressed_by_telegram_gate'), true);

  assert.equal(calls.patches.length, 1);
  assert.equal(calls.patches[0].body.alert_sent, false);
  assert.match(calls.patches[0].body.notes, /suppressed_by_telegram_gate/);
});

test('a failed Telegram send records alert_sent=false and the status code', async () => {
  const { payload, calls } = await runHandler({ telegram: 'http_error' });
  assert.equal(payload.alert_sent, false);
  assert.equal(calls.patches.length, 1);
  assert.equal(calls.patches[0].body.alert_sent, false);
  assert.match(calls.patches[0].body.notes, /telegram 400/);
});

test('an unchanged failing run inside the reminder window sends nothing and says why', async () => {
  // First pass: capture the exact result set this run produces.
  const first = await runHandler({ telegram: 'ok' });
  const producedResults = first.calls.inserts[0].body.results;
  assert.ok(producedResults.length > 0);

  // Second pass: identical results as "previous", and an alert delivered an
  // hour ago. Nothing changed => silence.
  const second = await runHandler({
    previousResults: producedResults,
    lastAlertRunAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    telegram: 'ok',
  });

  assert.equal(second.payload.alert_decision.alert, false);
  assert.equal(second.payload.alert_decision.kind, 'unchanged_suppressed');
  assert.equal(second.calls.telegram.length, 0, 'no daily 🚨 for unchanged red');
  assert.equal(second.payload.alert_sent, false);

  // Silence is still recorded — the row explains itself.
  assert.equal(second.calls.patches.length, 1);
  assert.equal(second.calls.patches[0].body.alert_sent, false);
  assert.match(second.calls.patches[0].body.notes, /unchanged_suppressed/);
});

test('the same unchanged failing run DOES nag once the reminder window has elapsed', async () => {
  const first = await runHandler({ telegram: 'ok' });
  const producedResults = first.calls.inserts[0].body.results;

  const stale = new Date(Date.now() - 200 * 3600 * 1000).toISOString(); // >168h
  const second = await runHandler({
    previousResults: producedResults,
    lastAlertRunAt: stale,
    telegram: 'ok',
  });

  assert.equal(second.payload.alert_decision.alert, true);
  assert.equal(second.payload.alert_decision.kind, 'still_failing_reminder');
  assert.equal(second.payload.alert_decision.is_reminder, true);
  assert.equal(second.calls.telegram.length, 1);
  // A reminder must name the standing failures, since there are no deltas.
  assert.match(second.calls.telegram[0].text, /Still failing/);
  assert.equal(second.payload.alert_sent, true);
});

test('an unauthenticated request is rejected before any test or alert runs', async () => {
  const originalFetch = globalThis.fetch;
  const touched = [];
  // NB: withTelemetry still upserts cron_runs after the 401 — that is by
  // design and not part of the alert path, so it is excluded below.
  globalThis.fetch = async (u) => { touched.push(String(u)); return json({}); };
  delete require.cache[CRON_PATH];
  delete require.cache[GATE_PATH];
  process.env.CRON_SECRET = 'test-secret';
  process.env.SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  try {
    const handler = require('./cron-regression-suite.js');
    let code = null; let payload = null;
    await handler({ headers: {} }, {
      status(c) { code = c; return this; },
      json(b) { payload = b; return this; },
    });
    assert.equal(code, 401);
    assert.equal(payload.ok, false);
    assert.equal(
      touched.filter((u) => u.includes('regression_runs') || u.includes('api.telegram.org')).length,
      0,
      'no run row and no alert from an unauthorised call'
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete require.cache[CRON_PATH];
    delete require.cache[GATE_PATH];
  }
});
