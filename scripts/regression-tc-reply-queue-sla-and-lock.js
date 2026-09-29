#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 3 gaps closed in scripts/fb-group-commenter.js's
 * --tc-reply-queue path (Carter, 2026-09-16 — closing the "auto-reply is ON
 * but nothing ever posts" gap: the reply-queue-post step now has a
 * scheduled tick (run-tc-discovery-harvest.cmd Step 3, every 15 min), but
 * three things around it still needed pinning down):
 *
 *   1. CAP/MIN-GAP HOLDS ACROSS RAPID TICKS: a 15-minute tick calling
 *      runTcReplyQueue back-to-back (simulating consecutive ticks) must
 *      never post two replies inside the 30-min facebook_reply min-gap,
 *      even with multiple approved rows sitting ready.
 *   2. MANUAL VS AUTO UNDER THE KILL SWITCH: with ops_flags.auto_reply OFF,
 *      an auto_approved row is refused (held back for manual review) while
 *      a manually-approved row (Heath tapped Approve) in the SAME run still
 *      posts — conflating the two would silently break Heath's own
 *      approvals whenever the flag is off.
 *   3. LOCKED PROFILE = QUIET SKIP, NOT CRASH: if the DossieBot-Sage Chrome
 *      profile is held by another process, tcReplyQueueMain must skip the
 *      tick quietly (return normally, log a line, never throw/exit(1)) and
 *      never force-kill the holder. A genuinely different unlock error must
 *      still surface (not be silently swallowed).
 *   4. 60-MINUTE REPLY SLA ALARM: checkApprovedReplyStale fires exactly
 *      once (dedup'd via alert_state) for an approved-but-unposted row
 *      older than 60 minutes, stays silent for a row under 60 minutes, and
 *      does not re-fire on a second call inside its own cooldown window.
 *
 * All against in-memory mocks — ZERO production access, no browser, no
 * Telegram, no Claude.
 *
 * Run manually:
 *   node scripts/regression-tc-reply-queue-sla-and-lock.js
 */

const assert = require('assert');

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-not-real';
process.env.TELEGRAM_MARKETING_BOT_TOKEN = 'test-token-not-real';
process.env.TELEGRAM_CHAT_ID = '1';

let passed = 0;
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

// ─── In-memory PostgREST mock (same shape as regression-auto-reply-veto.js) ──

function makeDb() {
  return { tc_discovery_responses: [], comment_caps_state: [], alert_state: [] };
}

function matchFilter(row, key, expr) {
  if (expr.startsWith('eq.')) return String(row[key]) === decodeURIComponent(expr.slice(3));
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
    if (method === 'POST') {
      const body = JSON.parse(init.body);
      const conflictCol = q.on_conflict;
      let stored = body;
      if (conflictCol) {
        const idx = rows.findIndex((r) => r[conflictCol] === body[conflictCol]);
        if (idx >= 0) { Object.assign(rows[idx], body); stored = rows[idx]; } else { rows.push({ ...body }); stored = body; }
      } else {
        rows.push({ ...body });
      }
      const wantsRep = String((init.headers || {}).Prefer || '').includes('return=representation');
      return { ok: true, status: wantsRep ? 200 : 201, data: wantsRep ? [{ ...stored }] : null };
    }
    return { ok: false, status: 405, data: null };
  };
}

function seedComment(db, over = {}) {
  const row = {
    id: `row-${db.tc_discovery_responses.length + 1}`,
    platform: 'facebook', // minGapElapsed's TC_ROW_PLATFORM filter reads this column
    post_url: 'https://www.facebook.com/groups/g/posts/1/',
    comment_permalink: `https://www.facebook.com/groups/g/posts/1/?comment_id=${db.tc_discovery_responses.length + 1}`,
    source_group: 'DFW Realtors',
    commenter_name: 'Jane Agent',
    comment_text: 'Communication. My last TC went dark for 9 days mid-option.',
    replied: false,
    reply_status: 'approved',
    reply_final: 'Ugh — did they ever explain what happened, or just resurface with no context?',
    reply_posted_at: null,
    reply_approved_at: new Date().toISOString(),
    reply_error: null,
    auto_approved: false,
    ...over,
  };
  db.tc_discovery_responses.push(row);
  return row;
}

const commenter = require('./fb-group-commenter.js');
const caps = require('./_lib/comment-caps.js');

const alwaysAllowCaps = { canComment: async () => ({ allowed: true }), minGapElapsed: async () => ({ elapsed: true }), recordComment: async () => {} };

async function main() {
  // ── 1. Cap/min-gap holds across rapid consecutive ticks ───────────────────
  await checkAsync('rapid consecutive ticks: real comment-caps.js never lets two replies post inside the 30-min min-gap', async () => {
    const db = makeDb();
    seedComment(db, { commenter_name: 'Agent A' });
    seedComment(db, { commenter_name: 'Agent B' });
    seedComment(db, { commenter_name: 'Agent C' });
    const sbFetch = makeSbFetch(db);
    let posterCalls = 0;
    const runTick = () => commenter.runTcReplyQueue({
      sbFetch, caps, // the REAL comment-caps.js — not a stub — so the 30-min gap is enforced for real
      poster: async () => { posterCalls++; return { submitted: true }; },
      verifier: async () => true,
      notify: async () => {},
      log: { log: () => {}, warn: () => {}, error: () => {} },
    });

    // Tick 1 (t=0min): one posts, the other two stay queued behind the gap.
    const t1 = await runTick();
    assert.strictEqual(t1.posted, 1, 'tick 1: exactly one posts');
    assert.strictEqual(posterCalls, 1);

    // Tick 2 (simulated 15 min later — still inside the 30-min gap): nothing new posts.
    const t2 = await runTick();
    assert.strictEqual(t2.posted, 0, 'tick 2 (15 min later, still inside 30-min gap): nothing posts');
    assert.strictEqual(posterCalls, 1, 'poster not called again inside the gap');

    // Tick 3 (simulated another 15 min later — 30 min total, gap elapsed): the next one posts.
    const posted1 = db.tc_discovery_responses.find((r) => r.reply_status === 'posted');
    posted1.reply_posted_at = new Date(Date.now() - 31 * 60000).toISOString(); // backdate past the gap
    const t3 = await runTick();
    assert.strictEqual(t3.posted, 1, 'tick 3 (gap elapsed): the next queued reply posts');
    assert.strictEqual(posterCalls, 2, 'still only 2 total posts across 3 ticks, never 2 inside one gap window');
  });

  // ── 2. Manual vs auto under the kill switch, same run ─────────────────────
  await checkAsync('kill switch OFF: auto_approved row held back, manually-approved row still posts in the SAME run', async () => {
    const db = makeDb();
    const autoRow = seedComment(db, { commenter_name: 'Auto Agent', auto_approved: true });
    const manualRow = seedComment(db, { commenter_name: 'Manual Agent', auto_approved: false, reply_approved_at: new Date(Date.now() + 1000).toISOString() });
    const sbFetch = makeSbFetch(db);
    let posterCalls = 0;
    const postedTo = [];
    const notifications = [];
    const res = await commenter.runTcReplyQueue({
      sbFetch,
      caps: alwaysAllowCaps,
      poster: async (row) => { posterCalls++; postedTo.push(row.commenter_name); return { submitted: true }; },
      verifier: async () => true,
      notify: async (t) => notifications.push(t),
      autoReplyKillSwitch: { isAutoReplyEnabled: async () => false }, // flag OFF
      log: { log: () => {}, warn: () => {}, error: () => {} },
    });
    assert.strictEqual(posterCalls, 1, 'exactly one post this run');
    assert.deepStrictEqual(postedTo, ['Manual Agent'], 'the MANUALLY-approved row posted, not the auto one');
    assert.strictEqual(autoRow.reply_status, 'notified', 'auto_approved row held back for manual Approve/Edit/Skip');
    assert.strictEqual(manualRow.reply_status, 'posted', 'manually-approved row is unaffected by the flag being off');
    assert.strictEqual(res.skipped, 1, 'one row skipped (the auto one)');
    assert.strictEqual(res.posted, 1, 'one row posted (the manual one)');
    assert.ok(notifications.some((t) => /switched off/i.test(t)), 'Heath told the auto row was held back');
  });

  // ── 3. Locked profile = quiet skip, not crash ──────────────────────────────
  await checkAsync('tcReplyQueueMain: locked profile skips the tick quietly (no throw, no exit)', async () => {
    const db = makeDb();
    seedComment(db, { commenter_name: 'Locked-Out Agent' });
    const sbFetch = makeSbFetch(db);
    const logLines = [];
    const lockedErr = new Error('Profile "C:\\Users\\Heath\\AppData\\Local\\DossieBot-Sage" still held after 90000ms by: pid 1234 (some-other-script.js). Not killing — pass { force: true } to override.');
    lockedErr.code = 'BROKERAGE_PROFILE_LOCKED';
    const unlockProfile = async () => { throw lockedErr; };

    // Must resolve normally (no throw) and never reach chromium/browser launch.
    await commenter.tcReplyQueueMain(
      { dryRun: false },
      { sbFetch, unlockProfile, log: { log: (...a) => logLines.push(a.join(' ')), error: (...a) => logLines.push(a.join(' ')) }, notify: async () => {} },
    );
    assert.ok(logLines.some((l) => /locked by another process/i.test(l) && /skipping this tick quietly/i.test(l)), 'logged a quiet-skip line');
    assert.ok(!logLines.some((l) => /Fatal error/i.test(l)), 'never logged as a fatal error');
    // The row is untouched — nothing claimed, nothing lost, next tick retries.
    assert.strictEqual(db.tc_discovery_responses[0].reply_status, 'approved', 'row left exactly as-is for the next tick');
  });

  await checkAsync('tcReplyQueueMain: a non-lock unlock error still surfaces (not silently swallowed)', async () => {
    const db = makeDb();
    seedComment(db, { commenter_name: 'Whatever Agent' });
    const sbFetch = makeSbFetch(db);
    const weirdErr = new Error('powershell query genuinely broken');
    const unlockProfile = async () => { throw weirdErr; };
    let threw = null;
    try {
      await commenter.tcReplyQueueMain({ dryRun: false }, { sbFetch, unlockProfile, log: { log: () => {}, error: () => {} }, notify: async () => {} });
    } catch (err) {
      threw = err;
    }
    assert.strictEqual(threw, weirdErr, 'a genuinely different error is NOT swallowed as a quiet skip');
  });

  // ── 4. 60-minute reply SLA alarm ───────────────────────────────────────────
  await checkAsync('SLA alarm: fires once for an approved row unposted >60min, dedup holds on immediate re-check', async () => {
    const db = makeDb();
    const stale = seedComment(db, {
      commenter_name: 'Stale Agent',
      reply_approved_at: new Date(Date.now() - 90 * 60000).toISOString(), // 90 min ago
    });
    const sbFetch = makeSbFetch(db);
    const notifications = [];
    const notify = async (t) => notifications.push(t);

    const r1 = await commenter.checkApprovedReplyStale(sbFetch, notify, { log: () => {} });
    assert.strictEqual(r1.fired, true, 'fires for a >60min stale approved row');
    assert.strictEqual(notifications.length, 1);
    assert.ok(/SLA MISS/i.test(notifications[0]));
    assert.ok(/Stale Agent/.test(notifications[0]), 'names the oldest offender');
    assert.strictEqual(db.alert_state.length, 1, 'alert_state row written');

    // Immediate re-check (same tick cadence, ~15 min later): still within
    // the alarm's own cooldown — must NOT alert again.
    const r2 = await commenter.checkApprovedReplyStale(sbFetch, notify, { log: () => {} });
    assert.strictEqual(r2.fired, false, 'second check inside cooldown does not re-fire');
    assert.strictEqual(r2.suppressed, true);
    assert.strictEqual(notifications.length, 1, 'still only ONE Telegram alert, not one per 15-min tick');
    void stale;
  });

  await checkAsync('SLA alarm: silent for a row approved less than 60 minutes ago', async () => {
    const db = makeDb();
    seedComment(db, { commenter_name: 'Fresh Agent', reply_approved_at: new Date(Date.now() - 10 * 60000).toISOString() });
    const sbFetch = makeSbFetch(db);
    const notifications = [];
    const r = await commenter.checkApprovedReplyStale(sbFetch, async (t) => notifications.push(t), { log: () => {} });
    assert.strictEqual(r.fired, false);
    assert.strictEqual(notifications.length, 0, 'no alert for a row well inside the SLA window');
  });

  await checkAsync('SLA alarm: silent when there is nothing approved-and-unposted at all', async () => {
    const db = makeDb();
    seedComment(db, { commenter_name: 'Posted Agent', reply_status: 'posted', reply_posted_at: new Date().toISOString(), reply_approved_at: new Date(Date.now() - 120 * 60000).toISOString() });
    const sbFetch = makeSbFetch(db);
    const notifications = [];
    const r = await commenter.checkApprovedReplyStale(sbFetch, async (t) => notifications.push(t), { log: () => {} });
    assert.strictEqual(r.fired, false);
    assert.strictEqual(notifications.length, 0, 'a row that already posted is not "stuck", never alerts');
  });

  console.log(`\n${passed} passed`);
  if (process.exitCode) {
    console.error('SOME TESTS FAILED');
  } else {
    console.log('ALL PASS');
  }
}

main().catch((err) => {
  console.error('FATAL:', err.stack || err.message);
  process.exit(1);
});
