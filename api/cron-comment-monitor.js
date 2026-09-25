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
// Schedule: */15 (Zernio caches comment reads up to 10 min; faster buys
// nothing). Owner: Atlas, rewritten 2026-09-25.
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const {
  makeBudget, listCommentedPosts, getPostComments,
} = require('./_lib/zernio-comments.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// How far back to look for posts carrying comments. Wide on purpose: a comment
// can land on a 6-month-old post and it still must not go unseen. The API's
// own filter is on POST creation time, not comment time.
const LOOKBACK_DAYS = 180;
const MAX_POSTS_PER_TICK = 40;
const REQUEST_BUDGET = 150;

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data, raw: text ? text.slice(0, 300) : '' };
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
  const sinceIso = new Date(Date.now() - LOOKBACK_DAYS * 86400 * 1000).toISOString();
  const errors = [];

  // 1. Ask the PLATFORM which posts have comments.
  const discovery = await listCommentedPosts({ minComments: 1, sinceIso, budget });
  errors.push(...discovery.errors);

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
      comments_seen: 0,
      requests_used: budget.used,
      account_failures: discovery.errors.filter((e) => e.stage === 'account').length,
      errors: errors.slice(0, 5),
    });
  }

  // 2. Pull every comment (and reply) on each, and upsert.
  let commentsSeen = 0;
  let itemsNew = 0;
  let ownSkipped = 0;
  const rows = [];

  for (const post of posts) {
    if (budget.exhausted) { errors.push({ stage: 'budget', detail: 'request budget exhausted mid-scan' }); break; }
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
    comments_seen: commentsSeen,
    own_comments_skipped: ownSkipped,
    candidates: rows.length,
    requests_used: budget.used,
    account_failures: discovery.errors.filter((e) => e.stage === 'account').length,
    error_count: errors.length,
    errors: errors.slice(0, 5),
  });
}

module.exports = withTelemetry('cron-comment-monitor', handler);
module.exports.handler = handler;
module.exports.toRow = toRow;
