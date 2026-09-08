#!/usr/bin/env node
'use strict';

/**
 * Regression test for the TC discovery comment-reply approval loop
 * (api/cron-tc-reply-approval.js + scripts/fb-group-commenter.js
 * --tc-reply-queue + api/_lib/telegram-gate.js allowlist +
 * supabase/migrations/20260908_tc_reply_approval.sql).
 *
 * THE RISKS BEING PINNED DOWN
 * ---------------------------
 * These are real professionals in groups Heath needs to stay welcome in, and
 * the cap is live on day one (6 harvested comments vs FB 5/day):
 *   1. APPROVAL GATE: nothing may ever post without Heath's explicit Approve.
 *      The queue must only select reply_status='approved' rows.
 *   2. NO DOUBLE-REPLY: the 'approved'->'posting' claim is atomic; posted /
 *      post_failed rows are terminal and never re-selected.
 *   3. CAP ENFORCEMENT: replies draw the dedicated 'facebook_reply' budget
 *      (10/day, comment-caps.js — split 2026-09-08 from the 'facebook'
 *      initiated-comment budget) — over-cap approved rows stay queued (still
 *      'approved'), Heath gets notified, nothing posts.
 *   4. SUPPRESSION LIES: a telegram-gate-suppressed send must NOT stamp
 *      reply_notified_at / advance to 'notified' (the exact bug class that
 *      hid five finished videos for three weeks). The stored draft must
 *      survive so the retry doesn't re-bill Claude.
 *   5. HOSTILE COMMENTS: flagged rows get NO draft posted — they can never
 *      reach the poster because they never become 'approved' automatically.
 *   6. VERIFY-FAIL IS TERMINAL: submitted-but-unverified goes 'post_failed'
 *      (may be live on FB — retry = double-reply) and still counts the cap.
 *   7. HARVEST HOT-WINDOW CADENCE: every 45 min for the first 48h, long tail
 *      after (the notification loop is useless on the old +24h cadence).
 *   8. Gate allowlist: 'cron-tc-reply-approval' is in ALWAYS_ALLOW.
 *
 * All against in-memory mocks — ZERO production access, no browser, no
 * Telegram, no Claude.
 *
 * Run manually:
 *   node scripts/regression-tc-reply-approval.js
 */

const assert = require('assert');
const path = require('path');

// Point env at nothing real BEFORE any module loads.
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-not-real';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real';
process.env.TELEGRAM_MARKETING_BOT_TOKEN = 'test-token-not-real';
process.env.TELEGRAM_CHAT_ID = '1';

// ─── In-memory PostgREST mock (function-level, no HTTP) ──────────────────────

const db = {
  tc_discovery_responses: [],
  group_posts: [],
  comment_caps_state: [],
};

function matchFilter(row, key, expr) {
  if (expr.startsWith('eq.')) return String(row[key]) === decodeURIComponent(expr.slice(3));
  if (expr.startsWith('in.(')) {
    const vals = expr.slice(4, -1).split(',').map(decodeURIComponent);
    return vals.includes(String(row[key]));
  }
  if (expr === 'is.null') return row[key] === null || row[key] === undefined;
  if (expr === 'not.is.null') return row[key] !== null && row[key] !== undefined;
  return true;
}

let nextId = 1;
async function mockSbFetch(urlPath, init = {}) {
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
    matched = [...matched].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (dir === 'desc' ? -1 : 1));
  }
  if (q.limit) matched = matched.slice(0, parseInt(q.limit, 10));

  const method = (init.method || 'GET').toUpperCase();
  if (method === 'GET') return { ok: true, status: 200, data: matched.map((r) => ({ ...r })) };
  if (method === 'POST') {
    const payload = JSON.parse(init.body);
    const arr = Array.isArray(payload) ? payload : [payload];
    const conflictCols = (q.on_conflict || '').split(',').filter(Boolean);
    const inserted = [];
    for (const r of arr) {
      const dupe = conflictCols.length > 0 && rows.some((ex) => conflictCols.every((c) => String(ex[c]) === String(r[c])));
      if (!dupe) { const row = { id: String(nextId++), ...r }; rows.push(row); inserted.push(row); }
    }
    return { ok: true, status: 201, data: inserted };
  }
  if (method === 'PATCH') {
    const patch = JSON.parse(init.body);
    for (const r of matched) {
      const real = rows.find((x) => x.id === r.id) || r;
      Object.assign(real, patch);
    }
    const wantsRep = String((init.headers || {}).Prefer || '').includes('return=representation');
    return { ok: true, status: wantsRep ? 200 : 204, data: wantsRep ? matched.map((r) => ({ ...rows.find((x) => x.id === r.id) })) : null };
  }
  return { ok: false, status: 405, data: null };
}

function seedComment(over = {}) {
  const row = {
    id: `row-${nextId++}`,
    group_post_id: 'post-1',
    post_url: 'https://www.facebook.com/groups/g/posts/1/',
    question_id: 'Q2',
    platform: 'facebook',
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
    ...over,
  };
  db.tc_discovery_responses.push(row);
  return row;
}

// ─── Load modules under test ─────────────────────────────────────────────────

const cron = require(path.join(__dirname, '..', 'api', 'cron-tc-reply-approval.js'));
const gate = require(path.join(__dirname, '..', 'api', '_lib', 'telegram-gate.js'));
const commenter = require(path.join(__dirname, 'fb-group-commenter.js'));
const caps = require(path.join(__dirname, '_lib', 'comment-caps.js'));
const harvester = require(path.join(__dirname, 'harvest-tc-discovery-responses.js'));

const SUPPRESSED_PAYLOAD = {
  ok: true, delivered: false, suppressed: true, suppressed_by: 'telegram-gate',
  result: { message_id: 0, date: 0 },
};
const DELIVERED_PAYLOAD = { ok: true, result: { message_id: 4242, date: 0 } };

async function main() {
  db.group_posts.push({ id: 'post-1', group_name: 'DFW Realtors', post_body: 'What drove you the most crazy about your TC?', post_url: 'https://www.facebook.com/groups/g/posts/1/' });

  // ── 8. Gate allowlist ──────────────────────────────────────────────────────
  assert.ok(gate.ALWAYS_ALLOW.has('cron-tc-reply-approval'),
    'cron-tc-reply-approval must be in telegram-gate ALWAYS_ALLOW — a gated notification is silently swallowed');

  // ── 4. Suppressed send must NOT advance state ─────────────────────────────
  const r1 = seedComment();
  let draftCalls = 0;
  const res1 = await cron.processPendingReplies({
    sbFetch: mockSbFetch,
    draft: async () => { draftCalls++; return { hostile: false, hostileReason: '', reply: 'Ugh, 9 days dark is brutal — did they ever explain what happened, or just resurface?' }; },
    send: async () => ({ ok: true, status: 200, data: SUPPRESSED_PAYLOAD }),
    isSuppressed: gate.wasSuppressed,
    log: { warn: () => {}, error: () => {} },
  });
  assert.strictEqual(res1.notified, 0, 'suppressed send counts 0 notified');
  assert.strictEqual(r1.reply_status, 'new', 'row stays new after suppressed send');
  assert.strictEqual(r1.reply_notified_at, null, 'reply_notified_at NOT stamped on suppressed send');
  assert.ok(r1.reply_draft, 'draft persisted despite suppression (retry must not re-bill Claude)');
  assert.ok(res1.errors.some((e) => e.error === 'suppressed_by_telegram_gate'), 'suppression surfaced as an error');

  // Retry with a working send: draft is REUSED (draft fn would throw), row advances.
  const res2 = await cron.processPendingReplies({
    sbFetch: mockSbFetch,
    draft: async () => { throw new Error('must not re-draft — draft already stored'); },
    send: async () => ({ ok: true, status: 200, data: DELIVERED_PAYLOAD }),
    isSuppressed: gate.wasSuppressed,
    log: { warn: () => {}, error: () => {} },
  });
  assert.strictEqual(res2.notified, 1, 'delivered retry notifies');
  assert.strictEqual(r1.reply_status, 'notified', 'row advances only on DELIVERED send');
  assert.ok(r1.reply_notified_at, 'reply_notified_at stamped on delivery');
  assert.strictEqual(r1.reply_telegram_message_id, '4242', 'telegram message id recorded');

  // ── 5. Hostile comment: flagged, no draft, message has NO buttons ─────────
  const r2 = seedComment({ commenter_name: 'Angry Andy', comment_text: 'This smells like an ad written by a bot.' });
  let flagMarkup = 'unset';
  await cron.processPendingReplies({
    sbFetch: mockSbFetch,
    draft: async () => ({ hostile: true, hostileReason: 'astroturf accusation', reply: '' }),
    send: async (text, markup) => { flagMarkup = markup; return { ok: true, status: 200, data: DELIVERED_PAYLOAD }; },
    isSuppressed: gate.wasSuppressed,
    log: { warn: () => {}, error: () => {} },
  });
  assert.strictEqual(r2.reply_status, 'flagged', 'hostile comment flagged');
  assert.strictEqual(r2.reply_draft, null, 'NO draft generated for hostile comment');
  assert.strictEqual(flagMarkup, null, 'flag message has no Approve button — his personal judgment only');

  // ── Message content: post context + comment + commenter + draft + buttons ─
  const msg = cron.buildApprovalMessage(db.group_posts[0], r1);
  assert.ok(msg.includes('What drove you the most crazy'), 'message includes the post for context');
  assert.ok(msg.includes('Jane Agent'), 'message includes the commenter name');
  assert.ok(msg.includes('9 days mid-option'), 'message includes the comment verbatim');
  assert.ok(msg.includes(r1.reply_draft), 'message includes the proposed reply');
  const kb = cron.approvalKeyboard(r1.id).inline_keyboard[0].map((b) => b.text).join(',');
  assert.strictEqual(kb, 'Approve,Edit,Skip', 'buttons are exactly Approve / Edit / Skip');

  // ── 1. APPROVAL GATE: nothing posts without 'approved' ────────────────────
  // r1 is 'notified', r2 is 'flagged' — neither may reach the poster.
  let posterCalls = 0;
  const neverPoster = async () => { posterCalls++; return { submitted: true }; };
  const alwaysVerify = async () => true;
  const notifications = [];
  const mockNotify = async (t) => { notifications.push(t); };

  const q1 = await commenter.runTcReplyQueue({
    sbFetch: mockSbFetch, caps, poster: neverPoster, verifier: alwaysVerify, notify: mockNotify,
    log: { log: () => {}, warn: () => {}, error: () => {} },
  });
  assert.strictEqual(posterCalls, 0, 'poster NEVER called for notified/flagged rows — approval gate holds');
  assert.strictEqual(q1.posted, 0, 'nothing posted without approval');

  // ── 3. CAP ENFORCEMENT: reply-budget daily cap blocks, rows stay queued ───
  const today = new Date().toISOString().slice(0, 10);
  db.comment_caps_state.push({ id: 'cap-1', platform: 'facebook_reply', day: today, count: caps.PLATFORM_DAILY_CAPS.facebook_reply });
  const approved = [];
  for (let i = 0; i < 3; i++) {
    approved.push(seedComment({
      reply_status: 'approved',
      reply_final: `Approved reply ${i} — thanks for the detail, what did that cost you per file?`,
      reply_approved_at: new Date(Date.now() - (10 - i) * 60000).toISOString(),
      comment_permalink: `https://www.facebook.com/groups/g/posts/1/?comment_id=${100 + i}`,
      commenter_name: `Agent ${i}`,
      comment_text: `Cap-test comment ${i}`,
    }));
  }
  const q2 = await commenter.runTcReplyQueue({
    sbFetch: mockSbFetch, caps, poster: neverPoster, verifier: alwaysVerify, notify: mockNotify,
    log: { log: () => {}, warn: () => {}, error: () => {} },
  });
  assert.strictEqual(posterCalls, 0, 'cap hit: poster never called');
  assert.strictEqual(q2.queuedForCap, 3, 'all 3 approved replies stay queued at the cap');
  assert.ok(approved.every((r) => r.reply_status === 'approved'), 'over-cap rows remain approved (not dropped, not failed)');
  assert.strictEqual(notifications.length, 1, 'Heath told exactly once that the cap queued replies');
  assert.ok(/cap/i.test(notifications[0]), 'cap notification mentions the cap');

  // ── Happy path + min-gap: one posts, the rest stay queued ─────────────────
  db.comment_caps_state.length = 0; // reset day counts
  const q3 = await commenter.runTcReplyQueue({
    sbFetch: mockSbFetch, caps, poster: neverPoster, verifier: alwaysVerify, notify: mockNotify,
    log: { log: () => {}, warn: () => {}, error: () => {} },
  });
  assert.strictEqual(posterCalls, 1, 'exactly one reply posted per run (45-min FB min-gap)');
  assert.strictEqual(q3.posted, 1, 'one posted');
  assert.strictEqual(q3.queuedForCap, 2, 'remaining two queued behind the min-gap');
  const posted = approved.find((r) => r.reply_status === 'posted');
  assert.ok(posted, 'posted row exists');
  assert.strictEqual(posted.replied, true, 'replied flag set on verified post');
  assert.ok(posted.reply_posted_at, 'reply_posted_at stamped');
  assert.strictEqual(db.comment_caps_state.length, 1, 'cap counter row created');
  assert.strictEqual(db.comment_caps_state[0].count, 1, 'cap incremented exactly once');

  // ── 2. NO DOUBLE-REPLY: claim is atomic; terminal rows never reselected ───
  const claimA = await commenter.claimApprovedReply(mockSbFetch, approved[1].id);
  assert.ok(claimA, 'first claim on an approved row wins');
  const claimB = await commenter.claimApprovedReply(mockSbFetch, approved[1].id);
  assert.strictEqual(claimB, null, 'second claim on the same row loses — double-reply lock holds');
  assert.strictEqual(approved[1].reply_status, 'posting', 'claimed row is posting');
  // A posted row can never be claimed again either.
  const claimPosted = await commenter.claimApprovedReply(mockSbFetch, posted.id);
  assert.strictEqual(claimPosted, null, 'posted row can never be re-claimed');

  // ── 6. VERIFY-FAIL: terminal post_failed, cap still counted, Heath alerted ─
  approved[1].reply_status = 'approved'; // un-claim for this scenario
  approved[1].reply_posted_at = null;
  approved[2].reply_status = 'skipped'; // isolate the scenario to one row
  posted.reply_posted_at = new Date(Date.now() - 60 * 60000).toISOString(); // min-gap elapsed
  notifications.length = 0;
  const capCountBefore = db.comment_caps_state[0].count;
  const q4 = await commenter.runTcReplyQueue({
    sbFetch: mockSbFetch, caps,
    poster: async () => ({ submitted: true }),
    verifier: async () => false, // submitted but can't read it back
    notify: mockNotify,
    log: { log: () => {}, warn: () => {}, error: () => {} },
  });
  assert.strictEqual(q4.failed, 1, 'verify-fail counted as failed');
  assert.strictEqual(approved[1].reply_status, 'post_failed', 'verify-fail is TERMINAL post_failed');
  assert.strictEqual(db.comment_caps_state[0].count, capCountBefore + 1, 'cap still counted — the reply may be live');
  assert.ok(notifications.some((t) => /verified|verif/i.test(t)), 'Heath alerted about the unverified submit');
  // And it is never selected again:
  const q5 = await commenter.runTcReplyQueue({
    sbFetch: mockSbFetch, caps, poster: neverPoster, verifier: alwaysVerify, notify: mockNotify,
    log: { log: () => {}, warn: () => {}, error: () => {} },
  });
  assert.strictEqual(q5.posted + q5.failed, 0, 'post_failed row never retried — no double-reply risk');

  // ── 7. Harvest hot-window cadence ─────────────────────────────────────────
  const t0 = Date.parse('2026-09-08T12:00:00Z');
  const post = { posted_at: '2026-09-08T12:00:00Z', post_url: 'https://x', harvest_count: 0, last_harvested_at: null };
  const MIN = 60000;
  assert.strictEqual(harvester.isDue(post, t0 + 10 * MIN), false, 'not due 10 min after posting');
  assert.strictEqual(harvester.isDue(post, t0 + 35 * MIN), true, 'first pass due ~30 min after posting (hot window)');
  assert.strictEqual(harvester.isDue({ ...post, harvest_count: 1, last_harvested_at: new Date(t0 + 35 * MIN).toISOString() }, t0 + 60 * MIN), false, 'not due 25 min after last hot-window pass');
  assert.strictEqual(harvester.isDue({ ...post, harvest_count: 1, last_harvested_at: new Date(t0 + 35 * MIN).toISOString() }, t0 + 85 * MIN), true, 'due 50 min after last hot-window pass (45-min interval)');
  const h47 = new Date(t0 + 47 * 60 * MIN).toISOString();
  assert.strictEqual(harvester.isDue({ ...post, harvest_count: 20, last_harvested_at: h47 }, t0 + 50 * 60 * MIN), false, 'long tail: not due 3h after last pass once past 48h');
  assert.strictEqual(harvester.isDue({ ...post, harvest_count: 20, last_harvested_at: h47 }, t0 + (47 + 73) * 60 * MIN), true, 'long tail: due 3+ days after last pass');
  assert.strictEqual(harvester.isDue({ ...post, harvest_count: 0 }, t0 + 60 * 60 * MIN), true, 'never-harvested post past 48h is due immediately (scheduler outage recovery)');
  assert.strictEqual(harvester.isDue(post, t0 + 46 * 86400000), false, 'never due after the 45-day window');

  // ── Static guards on the poster path ──────────────────────────────────────
  const fs = require('fs');
  const posterSrc = fs.readFileSync(path.join(__dirname, 'fb-group-commenter.js'), 'utf8');
  assert.ok(posterSrc.includes("reply_status=eq.approved"), 'queue selects ONLY approved rows');
  assert.ok(!/setTimeout\([^)]*auto.?approve/i.test(posterSrc), 'no timeout-based auto-approve anywhere in the poster');
  const cronSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'cron-tc-reply-approval.js'), 'utf8');
  assert.ok(/NEVER mention Dossie/i.test(cronSrc), 'draft prompt forbids mentioning Dossie');
  assert.ok(!/setTimeout\([^)]*approve/i.test(cronSrc), 'cron has no timer-based approve path');
  // Webhook wiring: approve/skip are guarded on reply_status=eq.notified so a
  // double-tap or stale button can never re-approve, and the edit flow exists.
  const webhookSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'telegram-webhook.js'), 'utf8');
  assert.ok(webhookSrc.includes('tcreply_(approve|edit|skip)'), 'webhook handles tcreply_* callbacks');
  assert.ok(webhookSrc.includes('reply_status=eq.notified'), 'webhook approve/skip guarded on notified status');
  assert.ok(webhookSrc.includes('TCREPLY_EDIT_PROMPT_PREFIX'), 'webhook has the TC reply edit flow');

  console.log('PASS: tc-reply-approval loop (approval gate, double-reply lock, cap+min-gap, gate suppression, hostile flagging, verify-fail terminal, hot-window cadence, allowlist)');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('FAIL:', err.message); process.exit(1); });
