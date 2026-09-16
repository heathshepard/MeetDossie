#!/usr/bin/env node
'use strict';

/**
 * Regression test for the auto-reply-with-veto pipeline end to end:
 * api/cron-tc-reply-approval.js (veto-path branch) + the STOP-tap PATCH
 * pattern used by api/telegram-webhook.js (autoreply_stop:<id>) +
 * api/cron-auto-reply-veto-check.js (deadline resolution + SLA sweep) +
 * scripts/_lib/auto-reply-kill-switch.js.
 *
 * THE RISKS BEING PINNED DOWN
 * ---------------------------
 *   1. KILL SWITCH OFF BY DEFAULT: a fresh switch file must never enable
 *      auto-posting. This is the ship-time requirement.
 *   2. KILL SWITCH GATES ENTRY: with the switch off, a low-risk comment
 *      still gets the ORIGINAL notified/Approve/Edit/Skip flow — never
 *      pending_veto — regardless of classifier/gate results.
 *   3. VETO WINDOW: a low-risk row with the switch on goes to
 *      'pending_veto' with a STOP-only keyboard and a veto_deadline_at
 *      ~10 minutes out.
 *   4. STOP CANCELS: a STOP tap before the deadline flips the row to
 *      'skipped' and the veto-check cron can never approve it afterward
 *      (status-guarded PATCH loses the race deterministically here since
 *      STOP already moved it off pending_veto).
 *   5. NO-STOP AUTO-APPROVES: past the deadline with no STOP tap, the
 *      veto-check cron flips the row to 'approved' with auto_approved=true
 *      — from there scripts/fb-group-commenter.js treats it exactly like a
 *      manual approval.
 *   6. MID-FLIGHT KILL: if the switch is flipped off AFTER a row enters
 *      pending_veto but BEFORE the deadline resolves, the veto-check cron
 *      falls back to 'notified' (manual review) instead of auto-approving.
 *   7. SLA ALERT: a comment sitting unanswered past 60 minutes gets exactly
 *      one alert (sla_alerted_at gates the repeat).
 *
 * All against in-memory mocks — ZERO production access, no browser, no
 * Telegram, no Claude, and the kill-switch state file is redirected to a
 * scratch path via AUTO_REPLY_SWITCH_FILE so this test can never touch the
 * real production switch.
 *
 * Run manually:
 *   node scripts/regression-auto-reply-veto.js
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Redirect the kill-switch state file to a scratch path BEFORE any module
// loads it — never touch the real production switch from a test.
const SCRATCH_SWITCH_FILE = path.join(os.tmpdir(), `auto-reply-switch-test-${process.pid}-${Date.now()}.json`);
process.env.AUTO_REPLY_SWITCH_FILE = SCRATCH_SWITCH_FILE;

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-not-real';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real';
process.env.TELEGRAM_MARKETING_BOT_TOKEN = 'test-token-not-real';
process.env.TELEGRAM_CHAT_ID = '1';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}\n    ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}\n    ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

// ─── In-memory PostgREST mock (same shape as regression-tc-reply-approval.js) ─

function makeDb() {
  return { tc_discovery_responses: [] };
}

function matchFilter(row, key, expr) {
  if (expr.startsWith('eq.')) return String(row[key]) === decodeURIComponent(expr.slice(3));
  if (expr.startsWith('in.(')) {
    const vals = expr.slice(4, -1).split(',').map(decodeURIComponent);
    return vals.includes(String(row[key]));
  }
  if (expr.startsWith('lte.')) return row[key] != null && new Date(row[key]).getTime() <= new Date(decodeURIComponent(expr.slice(4))).getTime();
  if (expr.startsWith('lt.')) return row[key] != null && new Date(row[key]).getTime() < new Date(decodeURIComponent(expr.slice(3))).getTime();
  if (expr === 'is.null') return row[key] === null || row[key] === undefined;
  if (expr === 'not.is.null') return row[key] !== null && row[key] !== undefined;
  return true;
}

function makeSbFetch(db) {
  return async function mockSbFetch(urlPath, init = {}) {
    const [pathname, qs] = urlPath.split('?');
    const table = pathname.replace('/rest/v1/', '');
    const rows = db[table];
    if (!rows) return { ok: false, status: 404, data: null };
    const q = {};
    for (const [k, v] of new URLSearchParams(qs || '')) q[k] = v;
    const filters = Object.entries(q).filter(([k]) => !['select', 'order', 'on_conflict', 'limit'].includes(k));
    let matched = rows.filter((r) => filters.every(([k, v]) => matchFilter(r, k, v)));
    if (q.order) {
      const [col, dir] = q.order.split('.');
      matched = [...matched].sort((a, b) => (a[col] > b[col] ? 1 : -1) * (dir === 'desc' ? -1 : 1));
    }
    if (q.limit) matched = matched.slice(0, Number(q.limit));
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'GET') return { ok: true, status: 200, data: matched };
    if (method === 'PATCH') {
      const patch = JSON.parse(init.body);
      for (const r of matched) Object.assign(r, patch);
      const wantsRep = String((init.headers || {}).Prefer || '').includes('return=representation');
      return { ok: true, status: wantsRep ? 200 : 204, data: wantsRep ? matched.map((r) => ({ ...r })) : null };
    }
    return { ok: false, status: 405, data: null };
  };
}

function seedComment(db, over = {}) {
  const row = {
    id: `row-${db.tc_discovery_responses.length + 1}`,
    group_post_id: 'post-1',
    post_url: 'https://www.facebook.com/groups/g/posts/1/',
    source_group: 'DFW Realtors',
    commenter_name: 'Jane Agent',
    comment_text: 'Communication. My last TC went dark for 9 days mid-option.',
    comment_permalink: 'https://www.facebook.com/groups/g/posts/1/?comment_id=11',
    is_own_comment: false,
    harvested_at: new Date().toISOString(),
    replied: false,
    reply_status: 'new',
    reply_draft: null,
    reply_final: null,
    reply_notified_at: null,
    reply_posted_at: null,
    reply_error: null,
    auto_reply_eligible: null,
    auto_reply_category: null,
    veto_deadline_at: null,
    auto_approved: false,
    sla_alerted_at: null,
    ...over,
  };
  db.tc_discovery_responses.push(row);
  return row;
}

// ─── Load modules under test ─────────────────────────────────────────────────

const killSwitch = require('./_lib/auto-reply-kill-switch.js');
const cron = require(path.join(__dirname, '..', 'api', 'cron-tc-reply-approval.js'));
const vetoCheck = require(path.join(__dirname, '..', 'api', 'cron-auto-reply-veto-check.js'));

const DELIVERED_PAYLOAD = { ok: true, result: { message_id: 4242, date: 0 } };
const CLEAN_DRAFT = 'yeah, mine went dark on me too once mid-option. built in a backup contact after that.';

function fakeDraftClean() {
  return async () => ({ hostile: false, hostileReason: '', reply: CLEAN_DRAFT });
}

// Stub for the risk classifier (now a real Claude Haiku 4.5 call in
// production — scripts/_lib/auto-reply-risk-classifier.js). This file
// tests the VETO WINDOW plumbing, not the model's judgment, so every row
// here gets a fixed high-confidence-eligible verdict — zero network,
// deterministic. See scripts/regression-auto-reply-classifier.js for the
// classifier's own harness/fail-closed coverage.
function highConfidenceEligible() {
  return async () => ({ eligible: true, category: 'auto_eligible', confidence: 'high', reason: 'stubbed for veto-window test', source: 'model' });
}

async function main() {
  console.log('auto-reply-with-veto: kill switch + veto window + SLA alert');

  // ── 1. Kill switch defaults OFF ─────────────────────────────────────────
  check('kill switch defaults to disabled on a fresh state file', () => {
    if (fs.existsSync(SCRATCH_SWITCH_FILE)) fs.unlinkSync(SCRATCH_SWITCH_FILE);
    assert.strictEqual(killSwitch.isAutoReplyEnabled(), false);
  });

  // ── 2. Switch OFF: low-risk comment never enters pending_veto ──────────
  await checkAsync('switch OFF: low-risk comment gets the ORIGINAL notified flow, not pending_veto', async () => {
    killSwitch.disableAutoReply('test');
    const db = makeDb();
    const row = seedComment(db);
    const sbFetch = makeSbFetch(db);
    let sentMarkup = null;
    const send = async (text, markup) => { sentMarkup = markup; return DELIVERED_PAYLOAD; };
    const res = await cron.processPendingReplies({
      sbFetch, draft: fakeDraftClean(), classifyRisk: highConfidenceEligible(), send, isSuppressed: () => false,
    });
    assert.strictEqual(res.notified, 1);
    assert.strictEqual(row.reply_status, 'notified');
    assert.strictEqual(row.veto_deadline_at, null);
    assert.ok(sentMarkup && sentMarkup.inline_keyboard[0].some((b) => b.callback_data.startsWith('tcreply_approve')), 'expected Approve/Edit/Skip buttons, not STOP');
    // Classification is still logged even though the switch blocked the veto path.
    assert.strictEqual(row.auto_reply_eligible, true);
    assert.strictEqual(row.auto_reply_category, 'auto_eligible');
  });

  // ── 3. Switch ON: low-risk comment enters pending_veto with STOP only ──
  let vetoRow;
  let vetoDb;
  await checkAsync('switch ON: low-risk comment enters pending_veto with a STOP-only keyboard and a ~10-min deadline', async () => {
    killSwitch.enableAutoReply('test');
    vetoDb = makeDb();
    vetoRow = seedComment(vetoDb);
    const sbFetch = makeSbFetch(vetoDb);
    let sentText = null;
    let sentMarkup = null;
    const send = async (text, markup) => { sentText = text; sentMarkup = markup; return DELIVERED_PAYLOAD; };
    const res = await cron.processPendingReplies({
      sbFetch, draft: fakeDraftClean(), classifyRisk: highConfidenceEligible(), send, isSuppressed: () => false,
    });
    assert.strictEqual(res.notified, 1);
    assert.strictEqual(res.autoVetoed, 1);
    assert.strictEqual(vetoRow.reply_status, 'pending_veto');
    assert.ok(vetoRow.veto_deadline_at, 'veto_deadline_at must be set');
    const deltaMs = new Date(vetoRow.veto_deadline_at).getTime() - Date.now();
    assert.ok(deltaMs > 9 * 60 * 1000 && deltaMs <= 10 * 60 * 1000, `expected ~10 min out, got ${deltaMs}ms`);
    assert.strictEqual(sentMarkup.inline_keyboard.length, 1);
    assert.strictEqual(sentMarkup.inline_keyboard[0].length, 1);
    assert.ok(sentMarkup.inline_keyboard[0][0].callback_data.startsWith('autoreply_stop:'));
    assert.ok(sentText.includes('AUTO-POSTING IN 10 MIN'));
  });

  // ── 4. STOP tap cancels before the deadline ─────────────────────────────
  await checkAsync('a STOP tap before the deadline cancels the row (skipped, terminal)', async () => {
    const sbFetch = makeSbFetch(vetoDb);
    // Same status-guarded PATCH api/telegram-webhook.js's autoreply_stop
    // handler performs.
    const patch = await sbFetch(
      `/rest/v1/tc_discovery_responses?id=eq.${vetoRow.id}&reply_status=eq.pending_veto`,
      { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ reply_status: 'skipped', reply_error: 'vetoed_by_heath' }) },
    );
    assert.ok(patch.ok && patch.data.length === 1, 'STOP should win the race while still pending_veto');
    assert.strictEqual(vetoRow.reply_status, 'skipped');
    assert.strictEqual(vetoRow.reply_error, 'vetoed_by_heath');
  });

  await checkAsync('the veto-check cron can never approve a row STOP already cancelled', async () => {
    // Force the deadline into the past — even so, the row is 'skipped' now,
    // not 'pending_veto', so the deadline-resolution query never selects it.
    vetoRow.veto_deadline_at = new Date(Date.now() - 60 * 1000).toISOString();
    const sbFetch = makeSbFetch(vetoDb);
    const sends = [];
    const send = async (text) => { sends.push(text); return DELIVERED_PAYLOAD; };
    const res = await vetoCheck.processVetoDeadlines({ sbFetch, send, isSuppressed: () => false, isAutoReplyEnabled: () => true });
    assert.strictEqual(res.autoApproved, 0);
    assert.strictEqual(vetoRow.reply_status, 'skipped', 'STOP is permanent');
  });

  // ── 5. No STOP: veto-check cron auto-approves past the deadline ────────
  let autoRow;
  let autoDb;
  await checkAsync('no STOP tap: past the deadline, veto-check cron auto-approves (auto_approved=true)', async () => {
    autoDb = makeDb();
    autoRow = seedComment(autoDb, {
      reply_status: 'pending_veto',
      reply_draft: CLEAN_DRAFT,
      veto_deadline_at: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    const sbFetch = makeSbFetch(autoDb);
    const sends = [];
    const send = async (text) => { sends.push(text); return DELIVERED_PAYLOAD; };
    const res = await vetoCheck.processVetoDeadlines({ sbFetch, send, isSuppressed: () => false, isAutoReplyEnabled: () => true });
    assert.strictEqual(res.autoApproved, 1);
    assert.strictEqual(autoRow.reply_status, 'approved');
    assert.strictEqual(autoRow.reply_final, CLEAN_DRAFT);
    assert.strictEqual(autoRow.auto_approved, true);
    assert.ok(sends.some((t) => /auto-approved/i.test(t)));
  });

  await checkAsync('a pending_veto row NOT yet past its deadline is left alone', async () => {
    const db = makeDb();
    const futureRow = seedComment(db, {
      reply_status: 'pending_veto',
      reply_draft: CLEAN_DRAFT,
      veto_deadline_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    const sbFetch = makeSbFetch(db);
    const res = await vetoCheck.processVetoDeadlines({ sbFetch, send: async () => DELIVERED_PAYLOAD, isSuppressed: () => false, isAutoReplyEnabled: () => true });
    assert.strictEqual(res.autoApproved, 0);
    assert.strictEqual(futureRow.reply_status, 'pending_veto');
  });

  // ── 6. Kill switch flipped off mid-flight falls back to manual ─────────
  await checkAsync('switch flipped OFF after entering pending_veto: falls back to notified, never auto-approves', async () => {
    const db = makeDb();
    const row = seedComment(db, {
      reply_status: 'pending_veto',
      reply_draft: CLEAN_DRAFT,
      veto_deadline_at: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    const sbFetch = makeSbFetch(db);
    const sends = [];
    const send = async (text) => { sends.push(text); return DELIVERED_PAYLOAD; };
    const res = await vetoCheck.processVetoDeadlines({ sbFetch, send, isSuppressed: () => false, isAutoReplyEnabled: () => false });
    assert.strictEqual(res.autoApproved, 0);
    assert.strictEqual(res.fellBackToManual, 1);
    assert.strictEqual(row.reply_status, 'notified');
    assert.strictEqual(row.auto_approved, false);
    assert.ok(sends.some((t) => /switched off/i.test(t)));
  });

  // ── 7. SLA alert: fires once, past 60 minutes, never twice ─────────────
  await checkAsync('SLA sweep alerts once for a comment unanswered past 60 minutes', async () => {
    const db = makeDb();
    const stale = seedComment(db, { harvested_at: new Date(Date.now() - 90 * 60 * 1000).toISOString(), reply_status: 'notified' });
    const fresh = seedComment(db, { harvested_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), reply_status: 'notified' });
    const sbFetch = makeSbFetch(db);
    const sends = [];
    const send = async (text) => { sends.push(text); return DELIVERED_PAYLOAD; };
    const res = await vetoCheck.sweepSlaAlerts({ sbFetch, send, isSuppressed: () => false });
    assert.strictEqual(res.alerted, 1);
    assert.ok(stale.sla_alerted_at, 'stale row gets stamped');
    assert.strictEqual(fresh.sla_alerted_at, null, 'fresh row is untouched');
    assert.ok(sends.some((t) => /SLA BREACH/.test(t)));

    // Second sweep: already-alerted row is not alerted again.
    const res2 = await vetoCheck.sweepSlaAlerts({ sbFetch, send, isSuppressed: () => false });
    assert.strictEqual(res2.alerted, 0, 'no repeat alert once sla_alerted_at is stamped');
  });

  // Cleanup scratch switch file.
  try { fs.unlinkSync(SCRATCH_SWITCH_FILE); } catch { /* already gone */ }

  console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}`);
  if (!process.exitCode) console.log('ALL PASS');
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exitCode = 1;
});
