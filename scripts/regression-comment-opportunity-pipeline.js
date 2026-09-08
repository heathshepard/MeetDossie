#!/usr/bin/env node
'use strict';

/**
 * Regression test for the DAILY comment-opportunity pipeline
 * (scripts/fb-comment-hunt-daily.js + api/cron-comment-opp-approval.js +
 * api/telegram-webhook.js oppc_* + scripts/fb-comment-opp-poster.js +
 * scripts/_lib/comment-hunt-halt.js +
 * supabase/migrations/20260908c_comment_opportunities.sql).
 *
 * THE RISKS BEING PINNED DOWN
 * ---------------------------
 * The whole distribution strategy runs through ONE Facebook profile that was
 * shadowbanned in June at 12 automated comments/day. So:
 *   1. APPROVAL GATE: nothing may ever post without Heath's explicit Approve
 *      or edit-reply. The queue must only select status='approved' rows.
 *   2. CAPS: the dedicated 'facebook_auto' budget (8/day default) blocks
 *      posting; over-cap approved rows stay queued, never dropped.
 *   3. SPACING: a post inside the 45-60 min varied gap blocks the run
 *      silently; at most ONE comment posts per run, ever.
 *   4. NO DOUBLE-COMMENT ON THE SAME POST, EVER: DB-unique post_url,
 *      comment_watchlist thread check, live already-commented DOM check,
 *      atomic 'approved'->'posting' claim, terminal posted/post_failed.
 *   5. SUPPRESSION LIES: a telegram-gate-suppressed send must NOT stamp
 *      notified_at / advance to 'notified' (the bug class that hid five
 *      finished videos for three weeks). Stored score+draft must survive so
 *      the retry doesn't re-bill Claude.
 *   6. CIRCUIT BREAKER: a verify failure or checkpoint redirect halts the
 *      pipeline; a halted pipeline posts NOTHING even with approved rows.
 *   7. WATCHLIST HANDOFF: a verified post registers in comment_watchlist
 *      (direction='heath_commented_on_others') so the guest-thread watcher
 *      catches replies.
 *   8. PREFILTER: listing spam / recruiting / stale / Heath's own posts never
 *      become candidates; genuine questions survive (bar is LOOSE by Heath's
 *      2026-09-08 instruction — only guaranteed dead weight is dropped).
 *
 * All against in-memory mocks — ZERO production access, no browser, no
 * Telegram, no Claude.
 *
 * Run manually:
 *   node scripts/regression-comment-opportunity-pipeline.js
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
  comment_opportunities: [],
  comment_watchlist: [],
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
  if (expr.startsWith('gte.')) {
    const v = decodeURIComponent(expr.slice(4));
    return row[key] != null && (isNaN(Number(v)) ? String(row[key]) >= v : Number(row[key]) >= Number(v));
  }
  if (expr.startsWith('lt.')) {
    const v = decodeURIComponent(expr.slice(3));
    return row[key] != null && (isNaN(Number(v)) ? String(row[key]) < v : Number(row[key]) < Number(v));
  }
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
    matched = [...matched].sort((a, b) => {
      const av = a[col]; const bv = b[col];
      const cmp = (typeof av === 'number' && typeof bv === 'number')
        ? (av < bv ? -1 : av > bv ? 1 : 0)
        : (String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0);
      return cmp * (dir === 'desc' ? -1 : 1);
    });
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
      if (!dupe) { const row = { id: `id-${nextId++}`, ...r }; rows.push(row); inserted.push(row); }
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

function seedOpp(over = {}) {
  const row = {
    id: `opp-${nextId++}`,
    group_key: 'dfw_network_collab',
    group_name: 'DFW Realtors - Network & Collaborate (38.7K)',
    group_url: 'https://www.facebook.com/groups/531847711158328/',
    post_url: `https://www.facebook.com/groups/531847711158328/posts/${nextId}/`,
    author_name: 'Jane Agent',
    post_text: 'Buyer wants to back out day 6 of a 7-day option period. Lender says appraisal came in 15k low. What would yall do about the option fee?',
    post_age_raw: '5h',
    comment_count: 3,
    found_at: new Date().toISOString(),
    score: null,
    score_reasons: null,
    status: 'found',
    comment_draft: null,
    comment_final: null,
    notified_at: null,
    telegram_message_id: null,
    approved_at: null,
    posted_at: null,
    error: null,
    watchlist_id: null,
    ...over,
  };
  db.comment_opportunities.push(row);
  return row;
}

// In-memory halt state (mirrors scripts/_lib/comment-hunt-halt.js contract).
function makeHaltState() {
  let entry = null;
  return {
    isHalted: () => entry !== null,
    setHalt: (reason, detail) => { entry = { reason, ...detail }; return entry; },
    getHalt: () => entry,
    clearHalt: () => { entry = null; },
  };
}

// ─── Load modules under test ─────────────────────────────────────────────────

const cron = require(path.join(__dirname, '..', 'api', 'cron-comment-opp-approval.js'));
const gate = require(path.join(__dirname, '..', 'api', '_lib', 'telegram-gate.js'));
const poster = require(path.join(__dirname, 'fb-comment-opp-poster.js'));
const caps = require(path.join(__dirname, '_lib', 'comment-caps.js'));
const hunt = require(path.join(__dirname, 'fb-comment-hunt-daily.js'));

const SUPPRESSED_PAYLOAD = {
  ok: true, delivered: false, suppressed: true, suppressed_by: 'telegram-gate',
  result: { message_id: 0, date: 0 },
};
const DELIVERED_PAYLOAD = { ok: true, result: { message_id: 7777, date: 0 } };

const quietLog = { log: () => {}, warn: () => {}, error: () => {} };

async function main() {
  // ── Gate allowlist ─────────────────────────────────────────────────────────
  assert.ok(gate.ALWAYS_ALLOW.has('cron-comment-opp-approval'),
    'cron-comment-opp-approval must be in telegram-gate ALWAYS_ALLOW — a gated notification silently stalls the pipeline');

  // ── Caps config: 8/day default, 45-min spacing floor ──────────────────────
  assert.strictEqual(caps.PLATFORM_DAILY_CAPS.facebook_auto, 8,
    'facebook_auto budget must default to 8/day (June shadowban was at 12/day)');
  assert.strictEqual(caps.MIN_GAP_MINUTES.facebook_auto, 45,
    'facebook_auto spacing floor must be 45 min');

  // ── 8. Prefilter: spam out, genuine in, bar stays loose ───────────────────
  const keepQ = hunt.prefilterPost({ postUrl: 'https://x/groups/g/posts/1', authorName: 'Jane', age: '3h', text: 'New TC here, two weeks in and drowning. How do you all keep deadlines straight across 6 files?' });
  assert.ok(keepQ.keep, 'genuine question survives the prefilter');
  const keepObs = hunt.prefilterPost({ postUrl: 'https://x/groups/g/posts/2', authorName: 'Bob', age: '1d', text: 'Noticed appraisers in our market are getting way more conservative this quarter. Curious if others are seeing the same on the north side deals.' });
  assert.ok(keepObs.keep, 'observation (not a question) survives — loose bar per Heath 2026-09-08');
  assert.ok(!hunt.prefilterPost({ postUrl: 'https://x/3', age: '2h', text: 'JUST LISTED! Gorgeous 4/2 in Stone Oak, granite everything, schedule your showing today, this beauty will not last long friends!' }).keep, 'listing spam dropped');
  assert.ok(!hunt.prefilterPost({ postUrl: 'https://x/4', age: '2h', text: 'We are hiring! Join our team at XYZ Realty, best splits in town, message me for details about our amazing culture and leads program' }).keep, 'recruiting dropped');
  assert.ok(!hunt.prefilterPost({ postUrl: 'https://x/5', age: '4d', text: 'Anyone have a good foundation guy in Boerne? Need a second opinion on a pier quote for a listing I am about to take.' }).keep, 'stale (>48h) dropped');
  assert.ok(!hunt.prefilterPost({ postUrl: null, age: '2h', text: 'Anyone have a good foundation repair contractor in Boerne they trust? Need a second opinion on a pier quote.' }).keep, 'no permalink = cannot post = dropped');
  assert.ok(!hunt.prefilterPost({ postUrl: 'https://x/6', authorName: 'Heath Shepard', age: '1h', text: 'What is everyone seeing on option fee amounts lately in the San Antonio market these days?' }).keep, 'Heath\'s own post dropped');

  // Scanner-level dedupe: same post_url inserted twice -> one row.
  const dupeIns1 = await mockSbFetch('/rest/v1/comment_opportunities?on_conflict=post_url', {
    method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ post_url: 'https://www.facebook.com/groups/g/posts/999/', group_name: 'G', group_url: 'https://g', post_text: 'x', status: 'found', found_at: new Date().toISOString() }),
  });
  const dupeIns2 = await mockSbFetch('/rest/v1/comment_opportunities?on_conflict=post_url', {
    method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ post_url: 'https://www.facebook.com/groups/g/posts/999/', group_name: 'G', group_url: 'https://g', post_text: 'x', status: 'found', found_at: new Date().toISOString() }),
  });
  assert.strictEqual(dupeIns1.data.length, 1, 'first insert lands');
  assert.strictEqual(dupeIns2.data.length, 0, 'duplicate post_url is a no-op — never a second candidate for the same post');
  db.comment_opportunities.length = 0;

  // ── 5. Suppressed send must NOT advance state ─────────────────────────────
  const r1 = seedOpp();
  let scoreCalls = 0;
  const res1 = await cron.processOpportunities({
    sbFetch: mockSbFetch,
    score: async () => { scoreCalls++; return { score: 88, reasons: 'real option-period question, 3 comments', comment: 'Day 6 the option fee is already earned either way - but if they terminate inside the period the EM comes back in full. The 15k-low appraisal gives them a cleaner exit under the third party financing addendum if they have one.' }; },
    send: async () => ({ ok: true, status: 200, data: SUPPRESSED_PAYLOAD }),
    isSuppressed: gate.wasSuppressed,
    log: quietLog,
  });
  assert.strictEqual(res1.notified, 0, 'suppressed send counts 0 notified');
  assert.strictEqual(r1.status, 'found', 'row stays found after suppressed send');
  assert.strictEqual(r1.notified_at, null, 'notified_at NOT stamped on suppressed send');
  assert.strictEqual(r1.score, 88, 'score persisted despite suppression');
  assert.ok(r1.comment_draft, 'draft persisted despite suppression (retry must not re-bill Claude)');
  assert.ok(res1.errors.some((e) => e.error === 'suppressed_by_telegram_gate'), 'suppression surfaced as an error');

  // Retry with a working send: score fn must NOT be re-called, row advances.
  const res2 = await cron.processOpportunities({
    sbFetch: mockSbFetch,
    score: async () => { throw new Error('must not re-score — score already stored'); },
    send: async () => ({ ok: true, status: 200, data: DELIVERED_PAYLOAD }),
    isSuppressed: gate.wasSuppressed,
    log: quietLog,
  });
  assert.strictEqual(res2.notified, 1, 'delivered retry notifies');
  assert.strictEqual(r1.status, 'notified', 'row advances only on DELIVERED send');
  assert.ok(r1.notified_at, 'notified_at stamped on delivery');
  assert.strictEqual(r1.telegram_message_id, '7777', 'telegram message id recorded');

  // ── Low score -> rejected, never notified ─────────────────────────────────
  const r2 = seedOpp({ post_text: 'Another gorgeous closing day! So blessed. #hustle', author_name: 'Brag Bob' });
  await cron.processOpportunities({
    sbFetch: mockSbFetch,
    score: async () => ({ score: 10, reasons: 'closed-brag, honest comment would be filler', comment: '' }),
    send: async () => { throw new Error('must not send for rejected rows'); },
    isSuppressed: gate.wasSuppressed,
    log: quietLog,
  });
  assert.strictEqual(r2.status, 'rejected', 'low-score candidate rejected');
  assert.strictEqual(r2.notified_at, null, 'rejected candidate never notified');

  // ── Message content: brief, has who/what/where/age/comments/draft ─────────
  const msg = cron.buildOppMessage(r1);
  assert.ok(msg.includes('DFW Realtors'), 'message names the group');
  assert.ok(msg.includes('Jane Agent'), 'message names the poster');
  assert.ok(msg.includes('option period'), 'message quotes the post');
  assert.ok(msg.includes('5h'), 'message shows post age');
  assert.ok(msg.includes('3 comments'), 'message shows comment count');
  assert.ok(msg.includes(r1.comment_draft.slice(0, 40)), 'message includes the draft');
  assert.ok(msg.split('\n').length <= 6, 'message stays brief — Heath asked for three lines of context, not five paragraphs');
  const kb = cron.oppKeyboard(r1.id).inline_keyboard[0].map((b) => b.text).join(',');
  assert.strictEqual(kb, 'Approve,Edit,Skip', 'buttons are exactly Approve / Edit / Skip');

  // ── Daily notify cap ──────────────────────────────────────────────────────
  const today = new Date().toISOString();
  for (let i = 0; i < cron.DAILY_NOTIFY_CAP; i++) seedOpp({ status: 'notified', notified_at: today, score: 70, comment_draft: 'x' });
  const rCapped = seedOpp({ score: 99, comment_draft: 'great draft', status: 'found' });
  const resCap = await cron.processOpportunities({
    sbFetch: mockSbFetch,
    score: async () => ({ score: 99, reasons: 'x', comment: 'y' }),
    send: async () => { throw new Error('must not send past the daily notify cap'); },
    isSuppressed: gate.wasSuppressed,
    log: quietLog,
  });
  assert.strictEqual(resCap.notified, 0, 'daily notify cap holds');
  assert.strictEqual(rCapped.status, 'found', 'over-cap candidate stays found for tomorrow');
  db.comment_opportunities.length = 0;

  // ── 1. APPROVAL GATE: nothing posts without 'approved' ────────────────────
  seedOpp({ status: 'found' });
  seedOpp({ status: 'notified', notified_at: today, comment_draft: 'draft text here' });
  seedOpp({ status: 'rejected' });
  let posterCalls = 0;
  const neverPoster = async () => { posterCalls++; return { submitted: true }; };
  const alwaysVerify = async () => true;
  const notifications = [];
  const mockNotify = async (t) => { notifications.push(t); };
  let haltState = makeHaltState();

  const q1 = await poster.runOppQueue({
    sbFetch: mockSbFetch, caps, poster: neverPoster, verifier: alwaysVerify,
    notify: mockNotify, log: quietLog, haltState, gapMinutes: 45,
  });
  assert.strictEqual(posterCalls, 0, 'poster NEVER called for found/notified/rejected rows — approval gate holds');
  assert.strictEqual(q1.posted, 0, 'nothing posted without approval');

  // ── 2. CAP ENFORCEMENT: facebook_auto daily cap blocks, rows stay queued ──
  const todayKey = new Date().toISOString().slice(0, 10);
  db.comment_caps_state.push({ id: 'cap-1', platform: 'facebook_auto', day: todayKey, count: caps.PLATFORM_DAILY_CAPS.facebook_auto });
  const approved = [];
  for (let i = 0; i < 3; i++) {
    approved.push(seedOpp({
      status: 'approved',
      comment_final: `Approved comment ${i} with enough substance to be a real reply about the option fee timing question.`,
      approved_at: new Date(Date.now() - (10 - i) * 60000).toISOString(),
      post_url: `https://www.facebook.com/groups/g/posts/${800 + i}/`,
    }));
  }
  const q2 = await poster.runOppQueue({
    sbFetch: mockSbFetch, caps, poster: neverPoster, verifier: alwaysVerify,
    notify: mockNotify, log: quietLog, haltState, gapMinutes: 45,
  });
  assert.strictEqual(posterCalls, 0, 'cap hit: poster never called');
  assert.strictEqual(q2.queuedForCap, 3, 'all 3 approved comments stay queued at the cap');
  assert.ok(approved.every((r) => r.status === 'approved'), 'over-cap rows remain approved (not dropped, not failed)');
  assert.strictEqual(notifications.length, 1, 'Heath told exactly once that the cap queued comments');

  // ── 3. SPACING: inside the varied gap -> silent queue; one per run ────────
  db.comment_caps_state.length = 0;
  notifications.length = 0;
  seedOpp({ status: 'posted', posted_at: new Date(Date.now() - 20 * 60000).toISOString(), post_url: 'https://www.facebook.com/groups/g/posts/700/' });
  const q3 = await poster.runOppQueue({
    sbFetch: mockSbFetch, caps, poster: neverPoster, verifier: alwaysVerify,
    notify: mockNotify, log: quietLog, haltState, gapMinutes: 45,
  });
  assert.strictEqual(posterCalls, 0, '20 min since last post < 45-min floor: nothing posts');
  assert.strictEqual(q3.queuedForCap, 3, 'approved rows silently queued behind the gap');
  assert.strictEqual(notifications.length, 0, 'gap wait is silent — resolves within the hour');

  // Gap elapsed: exactly ONE posts even with 3 approved.
  db.comment_opportunities.find((r) => r.post_url.endsWith('/700/')).posted_at = new Date(Date.now() - 61 * 60000).toISOString();
  const watchBefore = db.comment_watchlist.length;
  const q4 = await poster.runOppQueue({
    sbFetch: mockSbFetch, caps, poster: neverPoster, verifier: alwaysVerify,
    notify: mockNotify, log: quietLog, haltState, gapMinutes: 45,
  });
  assert.strictEqual(posterCalls, 1, 'exactly ONE comment posts per run');
  assert.strictEqual(q4.posted, 1, 'one posted');
  const posted = approved.find((r) => r.status === 'posted');
  assert.ok(posted, 'posted row exists');
  assert.ok(posted.posted_at, 'posted_at stamped');
  assert.strictEqual(db.comment_caps_state.length, 1, 'cap counter row created');
  assert.strictEqual(db.comment_caps_state[0].count, 1, 'cap incremented exactly once');

  // ── 7. WATCHLIST HANDOFF ──────────────────────────────────────────────────
  assert.strictEqual(db.comment_watchlist.length, watchBefore + 1, 'verified post registered in comment_watchlist');
  const watch = db.comment_watchlist[db.comment_watchlist.length - 1];
  assert.strictEqual(watch.direction, 'heath_commented_on_others', 'watch direction correct');
  assert.strictEqual(watch.source_table, 'comment_opportunities', 'watch provenance correct');
  assert.strictEqual(watch.thread_url, posted.post_url, 'watch thread_url is the post');
  assert.strictEqual(watch.our_text, posted.comment_final, 'watch carries the posted text verbatim');
  assert.strictEqual(posted.watchlist_id, watch.id, 'opportunity links back to its watch row');

  // ── 4. NO DOUBLE-COMMENT: watchlist thread check + atomic claim ───────────
  // (a) approved row whose thread is already watched -> skipped, poster never called.
  const dupeRow = seedOpp({
    status: 'approved', comment_final: 'This would be a second comment on the same thread and must never post at all.',
    approved_at: new Date(Date.now() - 5 * 60000).toISOString(),
    post_url: posted.post_url + '?dup=1',
  });
  dupeRow.post_url = posted.post_url; // same thread (bypass seed uniqueness)
  posted.posted_at = new Date(Date.now() - 61 * 60000).toISOString(); // gap open
  // Park the other approved rows so dupeRow is the only candidate.
  for (const r of approved) if (r.status === 'approved') r.status = 'skipped';
  posterCalls = 0;
  const q5 = await poster.runOppQueue({
    sbFetch: mockSbFetch, caps, poster: neverPoster, verifier: alwaysVerify,
    notify: mockNotify, log: quietLog, haltState, gapMinutes: 45,
  });
  assert.strictEqual(posterCalls, 0, 'thread already in comment_watchlist: poster never called');
  assert.strictEqual(dupeRow.status, 'skipped', 'duplicate-thread row skipped, not posted');
  assert.strictEqual(q5.skipped, 1, 'skip counted');

  // (b) atomic claim: double-tap loses; terminal rows never re-claimable.
  const claimTarget = seedOpp({ status: 'approved', comment_final: 'Claim-lock test comment with plenty of substance.', approved_at: new Date().toISOString() });
  const claimA = await poster.claimApprovedOpp(mockSbFetch, claimTarget.id);
  assert.ok(claimA, 'first claim on an approved row wins');
  const claimB = await poster.claimApprovedOpp(mockSbFetch, claimTarget.id);
  assert.strictEqual(claimB, null, 'second claim on the same row loses — double-post lock holds');
  const claimPosted = await poster.claimApprovedOpp(mockSbFetch, posted.id);
  assert.strictEqual(claimPosted, null, 'posted row can never be re-claimed');
  claimTarget.status = 'skipped'; // park

  // (c) live already-commented check -> skipped, NO cap count.
  const liveDupe = seedOpp({ status: 'approved', comment_final: 'Live-dupe test comment that must not post because Heath already commented there.', approved_at: new Date().toISOString() });
  const capBefore = db.comment_caps_state[0].count;
  const q6 = await poster.runOppQueue({
    sbFetch: mockSbFetch, caps,
    poster: async () => ({ alreadyCommented: true }),
    verifier: alwaysVerify, notify: mockNotify, log: quietLog, haltState, gapMinutes: 45,
  });
  assert.strictEqual(liveDupe.status, 'skipped', 'live already-commented thread: row skipped');
  assert.strictEqual(db.comment_caps_state[0].count, capBefore, 'no cap count when nothing was typed');
  assert.strictEqual(q6.posted, 0, 'nothing posted');

  // ── 6. VERIFY-FAIL: terminal post_failed + HALT + cap counted ─────────────
  const vfRow = seedOpp({ status: 'approved', comment_final: 'Verify-fail test comment that submits but cannot be read back from the thread.', approved_at: new Date().toISOString() });
  notifications.length = 0;
  const capBefore2 = db.comment_caps_state[0].count;
  const q7 = await poster.runOppQueue({
    sbFetch: mockSbFetch, caps,
    poster: async () => ({ submitted: true }),
    verifier: async () => false,
    notify: mockNotify, log: quietLog, haltState, gapMinutes: 45,
  });
  assert.strictEqual(q7.failed, 1, 'verify-fail counted as failed');
  assert.strictEqual(vfRow.status, 'post_failed', 'verify-fail is TERMINAL post_failed');
  assert.strictEqual(db.comment_caps_state[0].count, capBefore2 + 1, 'cap still counted — the comment may be live');
  assert.ok(haltState.isHalted(), 'verify-fail HALTS the whole pipeline');
  assert.ok(notifications.some((t) => /HALT/i.test(t)), 'Heath alerted about the halt');

  // Halted pipeline posts NOTHING even with approved rows waiting.
  const haltedRow = seedOpp({ status: 'approved', comment_final: 'Must never post while halted.', approved_at: new Date().toISOString() });
  posterCalls = 0;
  const q8 = await poster.runOppQueue({
    sbFetch: mockSbFetch, caps, poster: neverPoster, verifier: alwaysVerify,
    notify: mockNotify, log: quietLog, haltState, gapMinutes: 45,
  });
  assert.strictEqual(q8.halted, true, 'run reports halted');
  assert.strictEqual(posterCalls, 0, 'halted pipeline never calls the poster');
  assert.strictEqual(haltedRow.status, 'approved', 'approved rows survive the halt untouched');

  // post_failed is never re-selected after the halt clears.
  haltState.clearHalt();
  haltedRow.status = 'skipped'; // park so vfRow would be the only candidate if ever re-selected
  posterCalls = 0;
  const q9 = await poster.runOppQueue({
    sbFetch: mockSbFetch, caps, poster: neverPoster, verifier: alwaysVerify,
    notify: mockNotify, log: quietLog, haltState, gapMinutes: 45,
  });
  assert.strictEqual(posterCalls, 0, 'post_failed row never retried — no double-post risk');
  assert.strictEqual(q9.posted + q9.failed, 0, 'nothing re-attempted');

  // ── CHECKPOINT redirect: row reverts to approved, pipeline halts ──────────
  const cpRow = seedOpp({ status: 'approved', comment_final: 'Checkpoint test comment.', approved_at: new Date().toISOString() });
  notifications.length = 0;
  const q10 = await poster.runOppQueue({
    sbFetch: mockSbFetch, caps,
    poster: async () => { throw Object.assign(new Error('redirected to login/checkpoint'), { code: 'CHECKPOINT' }); },
    verifier: alwaysVerify, notify: mockNotify, log: quietLog, haltState, gapMinutes: 45,
  });
  assert.strictEqual(q10.halted, true, 'checkpoint halts the pipeline');
  assert.strictEqual(cpRow.status, 'approved', 'checkpoint reverts the claimed row to approved (nothing was typed)');
  assert.ok(haltState.isHalted(), 'halt state set on checkpoint');
  assert.ok(notifications.some((t) => /checkpoint|temp block/i.test(t)), 'Heath alerted about the checkpoint');

  // ── Static guards ─────────────────────────────────────────────────────────
  const fs = require('fs');
  const posterSrc = fs.readFileSync(path.join(__dirname, 'fb-comment-opp-poster.js'), 'utf8');
  assert.ok(posterSrc.includes('status=eq.approved&posted_at=is.null'), 'queue selects ONLY approved rows');
  assert.ok(!/setTimeout\([^)]*auto.?approve/i.test(posterSrc), 'no timeout-based auto-approve anywhere in the poster');
  const cronSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'cron-comment-opp-approval.js'), 'utf8');
  assert.ok(/NEVER mention Dossie/i.test(cronSrc), 'draft prompt forbids mentioning Dossie');
  assert.ok(/never a generic/i.test(cronSrc), 'draft prompt forbids filler comments');
  assert.ok(!/setTimeout\([^)]*approve/i.test(cronSrc), 'cron has no timer-based approve path');
  const webhookSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'telegram-webhook.js'), 'utf8');
  assert.ok(webhookSrc.includes('oppc_(approve|edit|skip)'), 'webhook handles oppc_* callbacks');
  assert.ok(/comment_opportunities\?id=eq\.\$\{encodeURIComponent\(rowId\)\}&status=eq\.notified/.test(webhookSrc), 'webhook approve/skip guarded on notified status');
  assert.ok(webhookSrc.includes('OPPC_EDIT_PROMPT_PREFIX'), 'webhook has the comment edit flow');
  const migrationSrc = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260908c_comment_opportunities.sql'), 'utf8');
  assert.ok(migrationSrc.includes('idx_comment_opportunities_post_url'), 'DB-level unique post_url index exists');
  assert.ok(migrationSrc.includes("'comment_opportunities'"), 'comment_watchlist source_table CHECK extended for this pipeline');
  const capsSrc = fs.readFileSync(path.join(__dirname, '_lib', 'comment-caps.js'), 'utf8');
  assert.ok(/facebook_auto:\s*8/.test(capsSrc), 'facebook_auto ceiling is the single config value in comment-caps.js');

  console.log('PASS: comment-opportunity pipeline (approval gate, 8/day cap, 45-60 varied spacing, one-per-run, no-double-comment x3 layers, gate suppression, circuit breaker, watchlist handoff, prefilter, notify cap)');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('FAIL:', err.message); process.exit(1); });
