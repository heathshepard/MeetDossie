'use strict';

// api/cron-comment-monitor.js
// =============================================================================
// INBOUND COMMENT INGESTION, via the Zernio API. No browser, no cookies.
//
// ─── WHAT WAS BROKEN ─────────────────────────────────────────────────────────
// This file existed since 2026-07-08 and fired every 15 minutes. It ingested
// ZERO comments in its entire life. social_comment_replies has never held a
// single row.
//
// The bug: it asked OUR database which posts might have comments —
//   social_posts?status=eq.posted&zernio_post_id=not.is.null
// and `zernio_post_id` is NULL on every recent posted row. Zero posts matched,
// so the loop body never ran, so it returned {posts_scanned: 0} in 66ms with
// last_status='ok'. For 79 consecutive days. Meanwhile GET /v1/inbox/comments
// showed 13 of our posts carrying real unanswered comments from real people,
// including LinkedIn threads the dead DossieBot Chrome profile could not see.
//
// It also called GET /posts/{id}/comments, which is not an endpoint. The real
// one is GET /v1/inbox/comments/{postId}?accountId=.
//
// ─── WHAT CHANGED ────────────────────────────────────────────────────────────
// Discovery is now GET /v1/inbox/comments — the platform's own list of every
// post carrying comments across every connected account. A post we never
// recorded, or recorded wrongly, can no longer hide a comment. "No comment
// goes unseen" is Heath's standing rule and this is the only version of this
// cron that can actually keep it.
//
// Three more things it now does that it did not:
//   1. Ingests REPLIES, not just top-level comments, and pages past Facebook's
//      10-inline-reply cap. A busy thread used to lose everything after #10.
//   2. Records account_id. Every comment read and every reply WRITE requires
//      it; without it an ingested row was unreplyable.
//   3. Reports an account whose token failed into credential_health instead of
//      swallowing it. A dead account is a silent hole in coverage.
//
// It does NOT draft or post anything. Drafting is cron-comment-reply-draft.js;
// posting is cron-post-comment-replies.js behind a kill switch.
//
// Schedule: */20 (moved from */15 2026-09-30 -- see "WHY EVERY20" below).
// Zernio caches comment reads up to 10 min anyway, so 15 vs 20 min buys
// nothing. Owner: Atlas, rewritten 2026-09-25, resumable scan 2026-09-30.
//
// ─── WHY EVERY20, AND THE RESUMABLE SCAN (2026-09-30) ────────────────────────
// Incident: this cron's own 15s internal deadline (added 2026-09-29 to stop a
// slow scan from taking down the whole every15 dispatcher) was hit MID-SCAN
// on a live every15 run. It returned early every time, and because discovery
// always restarted at cursor=null, every single tick re-walked the SAME first
// few pages and structurally could never reach the rest -- a truncating scan
// that always starts from the same place always misses the same tail.
//
// MEASURED LIVE AGAINST PROD, 2026-09-30 (not inferred):
//   - Per-post comment fetch (getPostComments): NOT the bottleneck. 0.8-1.7s
//     each, 5-way concurrent. Never the thing blowing the deadline.
//   - Discovery pagination (GET /v1/inbox/comments): THE bottleneck. Individual
//     pages measured 200ms-13.9s each (Zernio's own latency, highly variable --
//     raw uncached calls clustered 3-4s; some full-sweep pages spiked to ~14s).
//     A full sweep of the entire 3-year lookback window took 16 pages / 17
//     requests / ~80s wall-clock, and found 29 real posts carrying comments
//     (ground truth for this account set as of 2026-09-30).
//   - Repeating the EXACT same page (same since+cursor+limit) a second time
//     measured ~20-30x faster (6.8s cold -> ~200-300ms warm) -- a real Zernio
//     response cache, but keyed narrowly enough (same cursor, not just same
//     since) that it does not meaningfully help forward progress through new
//     pages, only retries of a page already fetched.
//
// So: an 80s full sweep never fit in every15's 15s self-deadline (nor its 30s
// member ceiling), but does fit in every20's ~290s member ceiling on a normal
// day -- with Zernio's measured per-page variance (up to 14s) still able to
// push a bad day past a single tick. RESUMABILITY (see cron_comment_monitor_
// state below) is what makes that survivable: a run that gets cut off resumes
// next tick from the exact page it stopped on, instead of re-scanning the same
// head of the list forever. Moving groups alone would not have fixed the
// structural miss; the cursor persistence is the actual fix, group headroom is
// what makes each individual sweep attempt likely to finish in one tick.
//
// RESUMABLE STATE: cron_comment_monitor_state, a singleton row (id=1) --
// supabase/migrations/20260930e_comment_monitor_resumable_cursor.sql.
//   discovery_cursor        - resume point. NULL = start a fresh sweep.
//   discovery_since         - the `since` this sweep is pinned to; reused
//                             verbatim across every resumed page (a Zernio
//                             cursor issued under one `since` replayed under a
//                             different one is unproven territory against the
//                             live API -- not worth risking a silent skip).
//   sweep_started_at         - when the CURRENT (or most recent) sweep began.
//   last_sweep_completed_at  - last time discovery reached hasMore=false, i.e.
//                             a full pass over the whole lookback window was
//                             PROVEN complete. This is the coverage guarantee,
//                             made visible: if it keeps advancing every few
//                             ticks, nothing in the window can stay
//                             permanently unseen.
//   posts_seen_this_sweep    - running count of unique posts found so far in
//                             the sweep in progress.
//   total_posts_last_sweep   - count from the most recently COMPLETED sweep,
//                             for monitoring / regression comparison.
// On hasMore=false the cursor resets to null and a new sweep begins next
// tick, which is what lets a NEW comment on a post we already passed (or a
// brand-new post) get picked up again -- not just a one-time backfill.
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const {
  makeBudget, listCommentedPosts, getPostComments,
} = require('./_lib/zernio-comments.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// How far back to look for posts carrying comments.
//
// Deliberately 3 years, not 30 days. The API's `since` filters on POST
// creation time, NOT comment time, so a narrow window does not mean "recent
// comments" -- it means "comments on recent posts", and a comment landing
// today on a two-year-old post would never be seen. Proven on the first live
// run: at 180 days this returned 7 of the 13 posts that actually carry
// comments; the 6 it dropped were older posts on Heath's realtor accounts.
//
// The cost of the wide window is one extra page or two, because the filter is
// on posts-with-comments, not on all posts. Cheap enough that narrowing it
// would be trading a correctness guarantee for nothing.
const LOOKBACK_DAYS = 1095;
const MAX_POSTS_PER_TICK = 40;
const REQUEST_BUDGET = 150;

// 2026-09-30 (Atlas) -- moved from every15 (40s group, 30s member ceiling) to
// every20 (300s group, ~290s member ceiling: runGroup derives per-member
// timeout as budgetMs - 10s reserve). Measured full sweep is ~80s-95s on a
// normal day; DEADLINE_MS below leaves >100s of headroom inside the group's
// own per-member ceiling rather than consuming the whole allowance, so a
// slower-than-measured day degrades to "resumes next tick" instead of
// "blows the dispatcher's budget."
//
// FETCH_TIMEOUT_MS raised from 6000 -- measured discovery pages legitimately
// take up to ~13.9s on a slow page; a 6s AbortSignal was aborting genuine
// in-flight requests and forcing the zernio() retry path to pay for them
// twice (abort + backoff + retry) instead of once. 15s covers every
// measured real page with margin, and every20's budget can afford it.
const FETCH_TIMEOUT_MS = 15000;
const DEADLINE_MS = 180000;
const CONCURRENCY_LIMIT = 5;

// A resumed cursor that's somehow gone stale (Zernio's own retention window,
// an account reconnect) should self-heal into a fresh sweep rather than
// error forever. Threshold is generous -- multiple worst-case measured full
// sweeps (~80-95s each) would still finish in well under this.
const STALE_CURSOR_MAX_AGE_MS = 24 * 3600 * 1000;

async function sb(path, init = {}) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    return { ok: res.ok, status: res.status, data, raw: text ? text.slice(0, 300) : '' };
  } catch (err) {
    // Abort (timeout) or any other network failure -> same {ok:false} shape
    // every caller here already handles; previously this had no try/catch at
    // all and a network error would throw uncaught out of the handler.
    return { ok: false, status: 0, data: null, error: String((err && err.message) || err), raw: '' };
  }
}

/** Bounded concurrency, deadline-aware. Never starts a new post's comment
 *  fetch past `deadlineAt`; in-flight fetches are bounded by FETCH_TIMEOUT_MS
 *  and the shared request budget, so worst-case overrun is small and finite. */
async function mapWithConcurrency(items, deadlineAt, worker) {
  let cursor = 0;
  let deadlineHit = false;
  const results = [];

  async function run() {
    for (;;) {
      if (Date.now() >= deadlineAt) { deadlineHit = true; return; }
      if (cursor >= items.length) return;
      const item = items[cursor];
      cursor += 1;
      const r = await worker(item);
      results.push(r);
    }
  }

  const n = Math.min(CONCURRENCY_LIMIT, items.length);
  await Promise.all(Array.from({ length: n }, run));
  return { results, deadlineHit, remaining: items.length - results.length };
}

/** Read the singleton resume-state row. Returns null if the migration
 *  (20260930e_comment_monitor_resumable_cursor.sql) hasn't been applied yet
 *  or the read fails -- callers fall back to "start a fresh sweep", which is
 *  exactly today's (pre-resumable) behavior, never worse. */
async function loadScanState() {
  const r = await sb('cron_comment_monitor_state?id=eq.1&select=*', {});
  if (r.ok && Array.isArray(r.data) && r.data[0]) return r.data[0];
  return null;
}

async function saveScanState(patch) {
  return sb('cron_comment_monitor_state?id=eq.1', {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}

/** Normalize one Zernio comment into a social_comment_replies row. */
function toRow(comment, post) {
  const from = comment.from || {};
  return {
    platform: post.platform,
    account_id: post.accountId,
    external_post_id: String(post.id),
    post_permalink: post.permalink || null,
    post_excerpt: String(post.content || '').slice(0, 1000),
    comment_external_id: String(comment.id),
    parent_comment_id: comment.parentId || null,
    comment_url: comment.url || null,
    commenter_platform_id: from.id || null,
    commenter_name: from.name || null,
    commenter_handle: from.username || from.name || null,
    original_comment: String(comment.message || '').slice(0, 4000),
    comment_created_at: comment.createdTime || null,
    reply_status: 'new',
    thread_status: 'open',
    last_seen_at: new Date().toISOString(),
  };
}

async function handler(req, res) {
  const handlerStart = Date.now();
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }
  if (!process.env.ZERNIO_API_KEY) {
    return res.status(503).json({ ok: false, error: 'zernio_env_missing' });
  }

  const budget = makeBudget(REQUEST_BUDGET);
  const errors = [];

  // Single absolute deadline for the WHOLE handler (discovery paging AND the
  // per-post comment loop below), not just the per-post loop. Measured live:
  // discovery's own pagination is the actual bottleneck (see file header) and
  // can consume the entire budget on its own before the per-post loop runs.
  const deadlineAt = handlerStart + DEADLINE_MS;

  // 0. Resume a sweep already in progress, or start a fresh one. See file
  // header "RESUMABLE STATE". A missing/unreadable state row (migration not
  // yet applied, transient read failure) degrades to "start fresh" -- never
  // worse than the pre-resumable behavior.
  const state = await loadScanState();
  const freshSince = new Date(Date.now() - LOOKBACK_DAYS * 86400 * 1000).toISOString();
  const stateAgeMs = state && state.sweep_started_at
    ? Date.now() - new Date(state.sweep_started_at).getTime()
    : Infinity;
  const resuming = !!(state && state.discovery_cursor && stateAgeMs < STALE_CURSOR_MAX_AGE_MS);

  const sinceIso = resuming ? state.discovery_since : freshSince;
  const resumeCursor = resuming ? state.discovery_cursor : null;
  const sweepStartedAt = resuming ? state.sweep_started_at : new Date().toISOString();
  const postsSeenBeforeThisTick = resuming ? (state.posts_seen_this_sweep || 0) : 0;

  // 1. Ask the PLATFORM which posts have comments, continuing from last
  // tick's cursor if this sweep isn't finished yet.
  const discovery = await listCommentedPosts({
    minComments: 1, sinceIso, budget, deadlineAt, cursor: resumeCursor,
  });
  errors.push(...discovery.errors);

  // Persist the new resume point immediately after discovery, independent of
  // whether the per-post loop below finishes -- the whole point of a
  // resumable scan is that discovery progress is never lost even if
  // everything after it fails or the tick runs out of time.
  const postsSeenThisSweep = postsSeenBeforeThisTick + discovery.posts.length;
  await saveScanState({
    discovery_cursor: discovery.cursor,
    discovery_since: sinceIso,
    sweep_started_at: sweepStartedAt,
    posts_seen_this_sweep: discovery.complete ? 0 : postsSeenThisSweep,
    ...(discovery.complete ? {
      last_sweep_completed_at: new Date().toISOString(),
      total_posts_last_sweep: postsSeenThisSweep,
    } : {}),
  });

  // An account that failed to answer is a hole in coverage, not a rounding
  // error. Write it where the outcome monitor already looks.
  for (const e of discovery.errors) {
    if (e.stage !== 'account') continue;
    await sb('credential_health?on_conflict=channel', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        channel: `zernio_${e.platform}_${e.username || e.accountId}`,
        probe_kind: 'live_action',
        logged_in: false,
        last_probe_at: new Date().toISOString(),
        detail: { source: 'cron-comment-monitor', code: e.code, error: e.error, accountId: e.accountId },
        updated_at: new Date().toISOString(),
      }),
    });
  }

  const posts = discovery.posts.slice(0, MAX_POSTS_PER_TICK);
  if (posts.length === 0) {
    return res.status(200).json({
      ok: true,
      items: 0,
      posts_with_comments: 0,
      deadline_hit: discovery.errors.some((e) => e.stage === 'discovery_deadline'),
      comments_seen: 0,
      requests_used: budget.used,
      account_failures: discovery.errors.filter((e) => e.stage === 'account').length,
      errors: errors.slice(0, 5),
      duration_ms: Date.now() - handlerStart,
      resumed_scan: resuming,
      discovery_pages_this_tick: discovery.pagesWalked,
      sweep_complete: discovery.complete,
      posts_seen_this_sweep: postsSeenThisSweep,
    });
  }

  // 2. Pull every comment (and reply) on each, and upsert.
  let commentsSeen = 0;
  let itemsNew = 0;
  let ownSkipped = 0;
  const rows = [];

  // Same absolute deadline as discovery above — the discovery call already
  // spent part of the handler's DEADLINE_MS budget; whatever's left is what
  // the per-post loop gets. Concurrency bounded at CONCURRENCY_LIMIT; the
  // shared request `budget` (Zernio call cap) is still honored inside the
  // worker exactly as it was in the sequential loop.
  const { deadlineHit: perPostDeadlineHit, remaining: postsNotScanned } = await mapWithConcurrency(posts, deadlineAt, async (post) => {
    if (budget.exhausted) { errors.push({ stage: 'budget', detail: 'request budget exhausted mid-scan' }); return; }
    const { comments, errors: cerr } = await getPostComments({
      postId: post.id, accountId: post.accountId, platform: post.platform, budget,
    });
    errors.push(...cerr);
    for (const c of comments) {
      if (!c || !c.id) continue;
      commentsSeen += 1;
      // Our own comments (and our own replies) are not inbound work.
      if (c.from && c.from.isOwner) { ownSkipped += 1; continue; }
      if (!String(c.message || '').trim()) continue;
      rows.push(toRow(c, post));
    }
  });
  const discoveryDeadlineHit = discovery.errors.some((e) => e.stage === 'discovery_deadline');
  const deadlineHit = discoveryDeadlineHit || perPostDeadlineHit;
  if (perPostDeadlineHit) {
    errors.push({ stage: 'deadline', detail: `${DEADLINE_MS}ms budget hit, ${postsNotScanned} of ${posts.length} posts not scanned this tick` });
  }

  // 3. One upsert. The unique index on (platform, comment_external_id) makes
  //    re-ingesting the same comment a no-op rather than a duplicate or a
  //    failed batch — which is what "nothing may be lost" actually requires.
  //    resolution=merge-duplicates would clobber a draft/approval already on
  //    the row, so ignore-duplicates is deliberate: the INSERT only ever
  //    creates, never overwrites human or pipeline state.
  if (rows.length) {
    const ins = await sb('social_comment_replies?on_conflict=platform,comment_external_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify(rows),
    });
    if (!ins.ok) {
      errors.push({ stage: 'upsert', status: ins.status, error: ins.raw });
    } else {
      itemsNew = Array.isArray(ins.data) ? ins.data.length : 0;
    }
  }

  // `items` is read by api/_lib/cron-telemetry.js withOutcome() and becomes
  // last_meta.outcome_items / outcome='produced'|'zero'. A run that ingests
  // nothing is now VISIBLE as zero instead of indistinguishable from success —
  // the exact thing that hid this cron's 79-day failure.
  return res.status(200).json({
    ok: true,
    items: itemsNew,
    posts_with_comments: posts.length,
    posts_not_scanned: postsNotScanned,
    deadline_hit: deadlineHit,
    comments_seen: commentsSeen,
    own_comments_skipped: ownSkipped,
    candidates: rows.length,
    requests_used: budget.used,
    account_failures: discovery.errors.filter((e) => e.stage === 'account').length,
    error_count: errors.length,
    errors: errors.slice(0, 5),
    duration_ms: Date.now() - handlerStart,
    // Resumable-scan visibility (2026-09-30) -- proves coverage instead of
    // asserting it. resumed_scan=true means this tick continued a sweep
    // already in progress rather than restarting at the head of the list.
    // sweep_complete=true means discovery reached hasMore=false THIS tick,
    // i.e. every post in the lookback window was walked this cycle.
    resumed_scan: resuming,
    discovery_pages_this_tick: discovery.pagesWalked,
    sweep_complete: discovery.complete,
    posts_seen_this_sweep: postsSeenThisSweep,
  });
}

module.exports = withTelemetry('cron-comment-monitor', handler);
module.exports.handler = handler;
module.exports.toRow = toRow;
