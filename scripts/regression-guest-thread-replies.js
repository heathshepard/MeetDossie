#!/usr/bin/env node
'use strict';

/**
 * Regression test for the GUEST-THREAD reply watcher — replies to comments
 * Heath leaves on OTHER PEOPLE'S posts (scripts/watch-guest-thread-replies.js
 * + the thread_role='guest' branch of api/cron-tc-reply-approval.js + the
 * facebook/facebook_reply budget split in scripts/_lib/comment-caps.js +
 * supabase/migrations/20260908b_guest_thread_reply_watch.sql).
 *
 * THE RISKS BEING PINNED DOWN
 * ---------------------------
 *   1. DETECTION: a reply to Heath's comment on a third-party post is found —
 *      only replies threaded under HIS comment, never top-level comments,
 *      never replies in other sub-threads, never Heath himself. Includes the
 *      three harvester defect classes fixed 2026-09-08: nested replies must
 *      dedupe on their OWN reply_comment_id (parent-id dedupe silently
 *      discarded every nested reply), FB's double-rendered DOM clones must
 *      collapse, and the expansion regex must match singular "View 1 reply".
 *   2. IDEMPOTENT UPSERT: re-watching the same thread never duplicates rows.
 *   3. WHOSE HOUSE: guest rows draft with guest context — the cron must know
 *      the reply came from the POST AUTHOR vs a third party, and the Telegram
 *      message must show the original post, Heath's comment, and the reply.
 *   4. SUPPRESSION LIES: a telegram-gate-suppressed send on a guest row must
 *      NOT stamp reply_notified_at (the 3-week video_library incident class).
 *   5. NO DOUBLE-REPLY: the atomic 'approved'->'posting' claim holds for
 *      guest rows; one reply per comment, ever.
 *   6. TWO BUDGETS: initiated comments ('facebook', 15/day) and automated
 *      replies ('facebook_reply', 10/day) are independent — a full initiated
 *      budget never blocks reply follow-through, a full reply budget never
 *      blocks initiated commenting, and the reply queue stops at ITS cap.
 *   7. HOSTILE guest replies get flagged with NO draft.
 *   8. CADENCE: watches reuse the harvester's hot-window/long-tail scheme.
 *
 * All against in-memory mocks — ZERO production access, no browser, no
 * Telegram, no Claude.
 *
 * PROVEN TO FAIL PRE-FIX: run this file in a worktree at the pre-change
 * commit — it fails immediately (watch-guest-thread-replies.js absent,
 * no facebook_reply budget, no thread_role support).
 *
 * Run manually:
 *   node scripts/regression-guest-thread-replies.js
 */

const assert = require('assert');
const path = require('path');
const crypto = require('crypto');

// Point env at nothing real BEFORE any module loads.
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-not-real';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real';
process.env.TELEGRAM_MARKETING_BOT_TOKEN = 'test-token-not-real';
process.env.TELEGRAM_CHAT_ID = '1';

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const normHashLocal = (s) => md5(String(s).replace(/\s+/g, ' ').trim());

// ─── In-memory PostgREST mock ────────────────────────────────────────────────

const db = {
  tc_discovery_responses: [],
  group_posts: [],
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
      // Simulate the DB's GENERATED comment_hash column so idempotency is
      // exercised the way production behaves.
      if (table === 'tc_discovery_responses' && r.comment_text != null && r.comment_hash == null) {
        r.comment_hash = normHashLocal(r.comment_text);
      }
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

// ─── Load modules under test ─────────────────────────────────────────────────

const watcher = require(path.join(__dirname, 'watch-guest-thread-replies.js'));
const cron = require(path.join(__dirname, '..', 'api', 'cron-tc-reply-approval.js'));
const gate = require(path.join(__dirname, '..', 'api', '_lib', 'telegram-gate.js'));
const commenter = require(path.join(__dirname, 'fb-group-commenter.js'));
const caps = require(path.join(__dirname, '_lib', 'comment-caps.js'));

const SUPPRESSED_PAYLOAD = {
  ok: true, delivered: false, suppressed: true, suppressed_by: 'telegram-gate',
  result: { message_id: 0, date: 0 },
};
const DELIVERED_PAYLOAD = { ok: true, result: { message_id: 7171, date: 0 } };

const THREAD = 'https://www.facebook.com/groups/othergroup/posts/777/';

async function main() {
  // ── 6a. Budget-split config pinned ────────────────────────────────────────
  assert.strictEqual(caps.PLATFORM_DAILY_CAPS.facebook, 15, 'initiated-comment budget is 15/day');
  assert.strictEqual(caps.PLATFORM_DAILY_CAPS.facebook_reply, 10, 'automated-reply budget is 10/day');
  assert.strictEqual(caps.TOTAL_DAILY_CAP, 41, 'total cap is the sum of all budgets');
  assert.strictEqual(caps.MIN_GAP_MINUTES.facebook_reply, 30, 'reply min-gap is 30 min');

  // ── 8. Gate allowlist still carries the (shared) approval cron ────────────
  assert.ok(gate.ALWAYS_ALLOW.has('cron-tc-reply-approval'),
    'cron-tc-reply-approval must stay in ALWAYS_ALLOW — guest notifications ride the same job');

  // ── 1. DETECTION ──────────────────────────────────────────────────────────
  const watch = {
    id: 'watch-1',
    thread_url: THREAD,
    group_name: 'SA Realtors',
    post_author: 'Maria Poster',
    direction: 'heath_commented_on_others',
    our_text: 'We switched to a shared checklist and it cut our missed deadlines in half.',
    posted_at: new Date(Date.now() - 60 * 60000).toISOString(),
    status: 'watching',
    check_count: 0,
    last_checked_at: null,
    post_body: null,
    our_comment_permalink: null,
  };
  db.comment_watchlist.push(watch);

  const scraped = [
    // Top-level comment by a stranger — NOT a reply to Heath.
    { author: 'Random Agent', text: 'Great discussion!', permalink: `${THREAD}?comment_id=500`, atRaw: '2h', at: null },
    // Heath's own comment (parent id 600).
    { author: 'Heath Shepard', text: 'We switched to a shared checklist and it cut our missed deadlines in half.', permalink: `${THREAD}?comment_id=600`, atRaw: '1h', at: null },
    // Reply from the POST AUTHOR under Heath's comment.
    { author: 'Maria Poster', text: 'Heath which checklist tool are you using?', permalink: `${THREAD}?comment_id=600&reply_comment_id=601`, atRaw: '45m', at: null },
    // FB double-rendered clone of the same reply (whitespace differs) — must collapse.
    { author: 'Maria Poster', text: 'Heath   which checklist tool are you using?', permalink: `${THREAD}?comment_id=600&reply_comment_id=601`, atRaw: '45m', at: null },
    // Third-party reply under Heath's comment. Carries the PARENT id 600 too —
    // parent-id dedupe (the 2026-09-08 harvester bug class) would discard it.
    { author: 'Jake Third', text: 'Following this, same struggle on my team.', permalink: `${THREAD}?comment_id=600&reply_comment_id=602`, atRaw: '30m', at: null },
    // Reply in a DIFFERENT sub-thread (parent 500) — excluded.
    { author: 'Other Person', text: 'Agreed with Random.', permalink: `${THREAD}?comment_id=500&reply_comment_id=501`, atRaw: '20m', at: null },
    // Heath replying inside his own thread — never a reply target.
    { author: 'Heath Shepard', text: 'Thanks Maria, will DM the details.', permalink: `${THREAD}?comment_id=600&reply_comment_id=603`, atRaw: '10m', at: null },
  ];

  const sel = watcher.selectRepliesToHeath(scraped, watch);
  assert.strictEqual(sel.found, true, 'Heath\'s comment located in the thread');
  assert.ok(sel.heathComment && sel.heathComment.permalink.includes('comment_id=600'), 'located the right comment');
  assert.strictEqual(sel.replies.length, 2, 'exactly the two replies to Heath detected (author + third party); clones, other sub-threads, top-level comments, and Heath himself excluded');
  assert.ok(sel.replies.some((r) => r.author === 'Maria Poster'), 'post-author reply detected');
  assert.ok(sel.replies.some((r) => r.author === 'Jake Third'), 'nested third-party reply NOT discarded by parent-id dedupe');

  // Fallback: our_text edited at paste time, but Heath has exactly ONE
  // top-level comment — still found. Two Heath top-level comments — never guess.
  const editedWatch = { ...watch, our_text: 'completely different text he typed instead' };
  assert.strictEqual(watcher.selectRepliesToHeath(scraped, editedWatch).found, true, 'single-Heath-comment fallback works when pasted text was edited');
  const twoHeath = [...scraped, { author: 'Heath Shepard', text: 'Separate second comment.', permalink: `${THREAD}?comment_id=700`, atRaw: '5m', at: null }];
  assert.strictEqual(watcher.selectRepliesToHeath(twoHeath, editedWatch).found, false, 'ambiguous (two Heath comments, no text match) -> no guessing');

  // Static guards: the shared machinery keeps the three 2026-09-08 fixes.
  const fs = require('fs');
  const harvSrc = fs.readFileSync(path.join(__dirname, 'harvest-tc-discovery-responses.js'), 'utf8');
  assert.ok(harvSrc.includes('\\d+ (reply|replies)'),
    'expansion regex still matches singular "View 1 reply" / "1 reply"');
  assert.ok(harvSrc.includes('tcHarvestClicked'), 'expansion loop still click-marks buttons (double-render clone starvation guard)');
  assert.ok(harvSrc.includes('reply_comment_id=(\\d+)'), 'harvester still dedupes nested replies on their OWN id');
  const watcherSrc = fs.readFileSync(path.join(__dirname, 'watch-guest-thread-replies.js'), 'utf8');
  assert.ok(watcherSrc.includes("require('./harvest-tc-discovery-responses.js')"), 'watcher REUSES the harvester machinery instead of re-implementing it');

  // ── 2. IDEMPOTENT UPSERT ──────────────────────────────────────────────────
  const nowIso = new Date().toISOString();
  const up1 = await watcher.upsertGuestReplies(watch, sel.replies, nowIso, mockSbFetch);
  assert.strictEqual(up1.inserted, 2, 'two guest rows inserted');
  const guestRows = db.tc_discovery_responses.filter((r) => r.thread_role === 'guest');
  assert.strictEqual(guestRows.length, 2, 'rows persisted');
  assert.ok(guestRows.every((r) => r.watchlist_id === 'watch-1' && r.is_own_comment === false && r.post_url === THREAD), 'guest rows carry watchlist link + thread url');
  const up2 = await watcher.upsertGuestReplies(watch, sel.replies, new Date().toISOString(), mockSbFetch);
  assert.strictEqual(up2.inserted, 0, 're-watch inserts nothing');
  assert.strictEqual(up2.seen, 2, 're-watch bumps last_seen_at instead');
  assert.strictEqual(db.tc_discovery_responses.filter((r) => r.thread_role === 'guest').length, 2, 'no duplicates ever');

  // Watch bookkeeping: reply_detected only from watching; post_body fills once.
  await watcher.recordWatchPass(watch, { postBody: 'Original post text about deadline chaos.', ourCommentPermalink: `${THREAD}?comment_id=600`, repliesFound: 2 }, nowIso, mockSbFetch);
  assert.strictEqual(watch.status, 'reply_detected', 'watch flips to reply_detected');
  assert.strictEqual(watch.check_count, 1, 'check_count bumped');
  assert.strictEqual(watch.post_body, 'Original post text about deadline chaos.', 'post body snapshot captured');
  const firstDetectedAt = watch.reply_detected_at;
  await watcher.recordWatchPass(watch, { postBody: 'DIFFERENT text', repliesFound: 1 }, new Date().toISOString(), mockSbFetch);
  assert.strictEqual(watch.post_body, 'Original post text about deadline chaos.', 'post_body only fills when empty');
  assert.strictEqual(watch.reply_detected_at, firstDetectedAt, 'reply_detected_at never re-stamped');
  assert.strictEqual(watch.check_count, 2, 'check_count keeps counting');

  // ── 8. CADENCE reuses the harvester scheme ────────────────────────────────
  const t0 = Date.parse('2026-09-08T12:00:00Z');
  const MIN = 60000;
  const freshWatch = { thread_url: THREAD, posted_at: '2026-09-08T12:00:00Z', check_count: 0, last_checked_at: null };
  assert.strictEqual(watcher.isWatchDue(freshWatch, t0 + 10 * MIN), false, 'not due 10 min after the comment');
  assert.strictEqual(watcher.isWatchDue(freshWatch, t0 + 35 * MIN), true, 'first pass ~30 min in (hot window)');
  assert.strictEqual(watcher.isWatchDue({ ...freshWatch, check_count: 1, last_checked_at: new Date(t0 + 35 * MIN).toISOString() }, t0 + 60 * MIN), false, 'not due 25 min after last hot pass');
  assert.strictEqual(watcher.isWatchDue({ ...freshWatch, check_count: 1, last_checked_at: new Date(t0 + 35 * MIN).toISOString() }, t0 + 85 * MIN), true, 'due 50 min after last hot pass');
  assert.strictEqual(watcher.isWatchDue({ ...freshWatch, check_count: 9, last_checked_at: new Date(t0 + 47 * 60 * MIN).toISOString() }, t0 + 50 * 60 * MIN), false, 'long tail: not due 3h later');
  assert.strictEqual(watcher.isWatchDue(freshWatch, t0 + 46 * 86400000), false, 'never due past 45 days');

  // ── 3 + 4. Guest drafting context + suppression on a guest row ───────────
  const mariaRow = db.tc_discovery_responses.find((r) => r.commenter_name === 'Maria Poster');
  const jakeRow = db.tc_discovery_responses.find((r) => r.commenter_name === 'Jake Third');
  // Make them cron-eligible the way the migration defaults would.
  for (const r of [mariaRow, jakeRow]) {
    Object.assign(r, { reply_status: 'new', reply_draft: null, reply_final: null, reply_notified_at: null, reply_posted_at: null, reply_error: null, replied: false, question_id: null, group_post_id: null, source_group: 'SA Realtors', harvested_at: r.harvested_at });
  }

  const guestCtxSeen = [];
  const res1 = await cron.processPendingReplies({
    sbFetch: mockSbFetch,
    draft: async (post, row, guest) => {
      guestCtxSeen.push({ name: row.commenter_name, guest });
      return { hostile: false, hostileReason: '', reply: `Draft for ${row.commenter_name}` };
    },
    send: async () => ({ ok: true, status: 200, data: SUPPRESSED_PAYLOAD }),
    isSuppressed: gate.wasSuppressed,
    log: { warn: () => {}, error: () => {} },
  });
  assert.strictEqual(res1.notified, 0, 'suppressed sends count 0 notified');
  assert.strictEqual(mariaRow.reply_status, 'new', 'guest row stays new after suppressed send');
  assert.strictEqual(mariaRow.reply_notified_at, null, 'reply_notified_at NOT stamped on suppressed send');
  assert.ok(mariaRow.reply_draft, 'guest draft persisted for the retry');
  const mariaCtx = guestCtxSeen.find((g) => g.name === 'Maria Poster');
  const jakeCtx = guestCtxSeen.find((g) => g.name === 'Jake Third');
  assert.ok(mariaCtx && mariaCtx.guest, 'guest context passed to the drafter');
  assert.strictEqual(mariaCtx.guest.replyIsFromPostAuthor, true, 'post-author reply recognized as the host of the thread');
  assert.strictEqual(jakeCtx.guest.replyIsFromPostAuthor, false, 'third-party reply recognized as a guest peer');
  assert.strictEqual(mariaCtx.guest.our_text, watch.our_text, 'Heath\'s own comment rides along as context');
  assert.strictEqual(mariaCtx.guest.post_body, watch.post_body, 'original post snapshot rides along as context');

  // Delivered retry: draft reused, rows advance.
  const res2 = await cron.processPendingReplies({
    sbFetch: mockSbFetch,
    draft: async () => { throw new Error('must not re-draft — stored draft must be reused'); },
    send: async () => ({ ok: true, status: 200, data: DELIVERED_PAYLOAD }),
    isSuppressed: gate.wasSuppressed,
    log: { warn: () => {}, error: () => {} },
  });
  assert.strictEqual(res2.notified, 2, 'both guest rows notified on delivered retry');
  assert.strictEqual(mariaRow.reply_status, 'notified', 'guest row advances only on DELIVERED send');

  // Telegram message content: whose house it is + all three context pieces.
  const guestCtx = { group_name: watch.group_name, post_author: watch.post_author, post_body: watch.post_body, our_text: watch.our_text, replyIsFromPostAuthor: true };
  const msg = cron.buildApprovalMessage({}, mariaRow, guestCtx);
  assert.ok(msg.includes("on Maria Poster's post"), 'message says whose post it is');
  assert.ok(msg.includes('Original post text about deadline chaos.'), 'message includes the original post');
  assert.ok(msg.includes(watch.our_text), 'message includes Heath\'s own comment');
  assert.ok(msg.includes('which checklist tool are you using'), 'message includes the reply verbatim');
  assert.ok(msg.includes('(the POST AUTHOR)'), 'message marks the post author');
  assert.ok(msg.includes(mariaRow.reply_draft), 'message includes the proposed reply');

  // ── 7. Hostile guest reply: flagged, no draft, no buttons ─────────────────
  db.tc_discovery_responses.push({
    id: `row-${nextId++}`, watchlist_id: 'watch-1', thread_role: 'guest', post_url: THREAD,
    platform: 'facebook', source_group: 'SA Realtors', commenter_name: 'Angry Annie',
    comment_text: 'This reads like an astroturf bot account farming engagement.',
    comment_permalink: `${THREAD}?comment_id=600&reply_comment_id=699`,
    comment_hash: normHashLocal('This reads like an astroturf bot account farming engagement.'),
    is_own_comment: false, harvested_at: new Date().toISOString(), replied: false,
    reply_status: 'new', reply_draft: null, reply_final: null, reply_notified_at: null, reply_posted_at: null, reply_error: null,
  });
  const hostileRow = db.tc_discovery_responses[db.tc_discovery_responses.length - 1];
  let flagMarkup = 'unset';
  await cron.processPendingReplies({
    sbFetch: mockSbFetch,
    draft: async () => ({ hostile: true, hostileReason: 'astroturf accusation', reply: '' }),
    send: async (text, markup) => { flagMarkup = markup; return { ok: true, status: 200, data: DELIVERED_PAYLOAD }; },
    isSuppressed: gate.wasSuppressed,
    log: { warn: () => {}, error: () => {} },
  });
  assert.strictEqual(hostileRow.reply_status, 'flagged', 'hostile guest reply flagged');
  assert.strictEqual(hostileRow.reply_draft, null, 'NO draft for hostile guest reply');
  assert.strictEqual(flagMarkup, null, 'flag message has no Approve button');

  // ── 6b. TWO BUDGETS are independent ───────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  // Fill the INITIATED budget to its cap — replies must still flow.
  db.comment_caps_state.push({ id: 'cap-fb', platform: 'facebook', day: today, count: caps.PLATFORM_DAILY_CAPS.facebook });
  const fbCheck = await caps.canComment('facebook', mockSbFetch);
  assert.strictEqual(fbCheck.allowed, false, 'initiated budget itself is at cap');
  const replyCheck = await caps.canComment('facebook_reply', mockSbFetch);
  assert.strictEqual(replyCheck.allowed, true, 'full initiated budget does NOT block the reply budget');

  // Approve Maria's reply and drain the queue: it must post despite facebook=15/15.
  Object.assign(mariaRow, { reply_status: 'approved', reply_final: 'Just a shared Google Sheet, honestly — the trick was making it the only source of truth.', reply_approved_at: new Date().toISOString() });
  let posterCalls = 0;
  const notifications = [];
  const q1 = await commenter.runTcReplyQueue({
    sbFetch: mockSbFetch, caps,
    poster: async () => { posterCalls++; return { submitted: true }; },
    verifier: async () => true,
    notify: async (t) => { notifications.push(t); },
    log: { log: () => {}, warn: () => {}, error: () => {} },
  });
  assert.strictEqual(q1.posted, 1, 'reply posted while the initiated budget is maxed');
  assert.strictEqual(posterCalls, 1, 'poster ran exactly once');
  assert.strictEqual(mariaRow.reply_status, 'posted', 'guest row posted + verified');
  assert.strictEqual(mariaRow.replied, true, 'replied flag set');
  const replyCapRow = db.comment_caps_state.find((r) => r.platform === 'facebook_reply');
  assert.ok(replyCapRow && replyCapRow.count === 1, 'reply budget (not the initiated budget) was charged');
  const fbCapRow = db.comment_caps_state.find((r) => r.platform === 'facebook');
  assert.strictEqual(fbCapRow.count, caps.PLATFORM_DAILY_CAPS.facebook, 'initiated budget untouched by the reply post');

  // Now fill the REPLY budget: approved replies stay queued, initiated stays open.
  replyCapRow.count = caps.PLATFORM_DAILY_CAPS.facebook_reply;
  fbCapRow.count = 0; // initiated budget open again
  Object.assign(jakeRow, { reply_status: 'approved', reply_final: 'Right there with you — weekly file audit was our fix.', reply_approved_at: new Date().toISOString() });
  posterCalls = 0;
  const q2 = await commenter.runTcReplyQueue({
    sbFetch: mockSbFetch, caps,
    poster: async () => { posterCalls++; return { submitted: true }; },
    verifier: async () => true,
    notify: async (t) => { notifications.push(t); },
    log: { log: () => {}, warn: () => {}, error: () => {} },
  });
  assert.strictEqual(posterCalls, 0, 'reply-budget cap: poster never called');
  assert.strictEqual(q2.queuedForCap, 1, 'over-cap approved reply stays queued');
  assert.strictEqual(jakeRow.reply_status, 'approved', 'queued row remains approved (not dropped, not failed)');
  assert.ok(notifications.some((t) => /cap/i.test(t)), 'Heath told the reply cap queued it');
  const fbCheck2 = await caps.canComment('facebook', mockSbFetch);
  assert.strictEqual(fbCheck2.allowed, true, 'full reply budget does NOT block initiated commenting');

  // ── 5. NO DOUBLE-REPLY on guest rows ──────────────────────────────────────
  const claimA = await commenter.claimApprovedReply(mockSbFetch, jakeRow.id);
  assert.ok(claimA, 'first claim on an approved guest row wins');
  const claimB = await commenter.claimApprovedReply(mockSbFetch, jakeRow.id);
  assert.strictEqual(claimB, null, 'second claim loses — double-reply lock holds for guest rows');
  const claimPosted = await commenter.claimApprovedReply(mockSbFetch, mariaRow.id);
  assert.strictEqual(claimPosted, null, 'posted guest row can never be re-claimed');

  // ── Static guards ─────────────────────────────────────────────────────────
  const cronSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'cron-tc-reply-approval.js'), 'utf8');
  assert.ok(/GUEST_DRAFT_PROMPT/.test(cronSrc), 'guest prompt exists');
  assert.ok((cronSrc.match(/NEVER mention Dossie/g) || []).length >= 2, 'no-pitch rule present in BOTH host and guest prompts');
  assert.ok(!/setTimeout\([^)]*approve/i.test(cronSrc), 'no timer-based approve path');
  const posterSrc = fs.readFileSync(path.join(__dirname, 'fb-group-commenter.js'), 'utf8');
  assert.ok(posterSrc.includes("reply_status=eq.approved"), 'queue selects ONLY approved rows');
  assert.ok(posterSrc.includes("'facebook_reply'"), 'poster charges the dedicated reply budget');

  console.log('PASS: guest-thread reply watcher (detection incl. 3 fixed defect classes, idempotent upsert, whose-house drafting, suppression never marks notified, double-reply lock, independent facebook/facebook_reply budgets, hostile flagging, cadence reuse)');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('FAIL:', err.message); process.exit(1); });
