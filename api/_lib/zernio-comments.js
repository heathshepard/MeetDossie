'use strict';

// api/_lib/zernio-comments.js
// =============================================================================
// THE ZERNIO COMMENT API CLIENT. One place that knows how to read comments,
// reply to them, and manage comment-to-DM automations.
//
// WHY IT EXISTS: the comment/reply engine ran through the DossieBot Chrome
// profile, which is logged out of Facebook and LinkedIn and has been for 9
// days. Cookies were a dependency we chose and mostly don't need. Heath:
// "I can't have this cookies-are-gone bullshit or it just falls apart."
//
// ─── VERIFIED AGAINST THE LIVE API 2026-09-25 ────────────────────────────────
// Everything below marked VERIFIED was probed with a real key against
// https://zernio.com/api/v1, not read off docs.zernio.com. The docs and the
// API disagree in places and the disagreements matter:
//
//   VERIFIED  GET  /v1/accounts                       -> 200, 12 accounts
//   VERIFIED  GET  /v1/inbox/comments                 -> 200 (no Inbox-addon
//             403). Enumerates every post carrying comments across every
//             connected account. 13 of our posts had unanswered comments.
//   VERIFIED  GET  /v1/inbox/comments/{postId}?accountId=
//                                                     -> 200, full comment
//             objects incl. from.isOwner / canReply / replies[]
//   VERIFIED  GET  /v1/comment-automations            -> 200
//   VERIFIED  POST /v1/comment-automations            -> 200
//   VERIFIED  GET  /v1/comment-automations/{id}       -> 200
//   VERIFIED  PATCH /v1/comment-automations/{id}      -> 200 (isActive honored)
//   VERIFIED  GET  /v1/comment-automations/{id}/logs  -> 200 (+ `misses`)
//   VERIFIED  DELETE /v1/comment-automations/{id}     -> 200
//   DOCS ONLY POST /v1/inbox/comments/{postId}        -- posting a reply writes
//             to a real person's thread, so it is NOT probed here. It is
//             exercised only behind the ops_flags kill switch.
//
// ─── THREE PLACES THE DOCS ARE WRONG OR MISLEADING ───────────────────────────
//
// 1. POST /v1/comment-automations SILENTLY IGNORES `isActive: false`.
//    Sent it explicitly; response came back `isActive: true`. An automation is
//    LIVE the instant it is created. There is no "create paused" — the only
//    way to a paused automation is create-then-PATCH, which has a live window.
//    createAutomation() below always closes that window and VERIFIES it did.
//
// 2. "only one active per-post automation is allowed per post" is not enforced.
//    A second create on the same post returned 200. Keyword uniqueness is ours
//    to hold (unique index on video_comment_automations), never Zernio's.
//
// 3. POST /{postId}/{commentId}/moderation is YOUTUBE ONLY, and so is
//    `banAuthor`. It is not the general reply/moderate path. Replies go through
//    POST /v1/inbox/comments/{postId} with a `commentId` in the BODY. Hiding is
//    a different endpoint again (Facebook, Instagram, Threads, X, TikTok).
//
// ─── RATE LIMITS ─────────────────────────────────────────────────────────────
// 60 / 600 / 1200 requests per minute by connected-account count, sliding
// window. Live headers say X-RateLimit-Limit: 600 for this key. Every response
// is read for X-RateLimit-Remaining and a 429's Retry-After is honored. Callers
// also get a budget (see makeBudget) so a runaway loop stops itself rather than
// discovering the ceiling by hitting it.
//
// Comment reads are cached by Zernio for up to 10 MINUTES. Polling faster than
// that buys nothing. The real-time upgrade path is the `comment.received`
// webhook, which is deliberately NOT built here: polling has no registration,
// no signature verification and no missed-delivery backfill to get wrong, and
// at our volume a 15-minute lag is not the problem worth solving first.
//
// Owner: Atlas, 2026-09-25
// =============================================================================

const ZERNIO_BASE = 'https://zernio.com/api/v1';

// Comment-to-DM automations exist on these platforms and no others. Verified:
// the API's own enum for automation.platform is `one of: instagram, facebook`.
const DM_AUTOMATION_PLATFORMS = new Set(['instagram', 'facebook']);

// Platforms whose comments we can read AND reply to through Zernio. LinkedIn is
// on this list, which is the entire point: LinkedIn is one of the channels the
// dead Chrome profile took down.
const REPLYABLE_PLATFORMS = new Set([
  'facebook', 'instagram', 'linkedin', 'twitter', 'youtube', 'threads',
  'reddit', 'bluesky', 'tiktok',
]);

function apiKey() {
  const k = process.env.ZERNIO_API_KEY;
  if (!k) throw new Error('zernio_env_missing');
  return k;
}

/**
 * A per-run request budget. A cron that walks N posts should not be able to
 * turn into thousands of calls because a cursor loop went wrong.
 */
function makeBudget(max = 120) {
  return { max, used: 0, exhausted: false };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Single Zernio call. Never throws on an HTTP error — returns a result object,
 * because every caller here needs to record the failure per-item and carry on
 * rather than abort a whole batch on one bad account.
 *
 * Retries only 429 and 5xx, and only twice. A 4xx is a real answer.
 */
async function zernio(path, init = {}, budget = null) {
  if (budget) {
    if (budget.used >= budget.max) {
      budget.exhausted = true;
      return { ok: false, status: 0, error: 'request_budget_exhausted', data: null };
    }
    budget.used += 1;
  }

  let attempt = 0;
  for (;;) {
    attempt += 1;
    let res;
    try {
      res = await fetch(`${ZERNIO_BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(init.headers || {}),
        },
      });
    } catch (err) {
      if (attempt >= 3) return { ok: false, status: 0, error: err.message, data: null };
      await sleep(500 * attempt);
      continue;
    }

    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }

    if (res.status === 429 && attempt < 3) {
      // Honor the server's own number rather than guessing. Retry-After is in
      // seconds; X-RateLimit-Reset is an absolute unix timestamp.
      const retryAfter = Number(res.headers.get('retry-after'));
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      let waitMs = 2000 * attempt;
      if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = retryAfter * 1000;
      else if (Number.isFinite(reset) && reset > 0) waitMs = Math.max(0, reset * 1000 - Date.now());
      await sleep(Math.min(waitMs, 30000));
      continue;
    }

    if (res.status >= 500 && attempt < 3) {
      await sleep(1000 * attempt);
      continue;
    }

    return {
      ok: res.ok,
      status: res.status,
      data,
      raw: text ? text.slice(0, 600) : '',
      rateLimitRemaining: Number.isFinite(remaining) ? remaining : null,
      error: res.ok ? null : (data && data.error) || text.slice(0, 200),
    };
  }
}

// ─── READS ────────────────────────────────────────────────────────────────────

/**
 * Every post across every connected account that currently carries comments.
 *
 * THIS IS THE DISCOVERY MECHANISM, and choosing it is the fix for the bug this
 * whole module replaces. The previous monitor asked OUR database which posts
 * might have comments (`social_posts.zernio_post_id=not.is.null`) — a column
 * that is NULL on every recent row — so it scanned zero posts and reported
 * success for 79 consecutive days. Asking the platform instead means a post we
 * never recorded, or recorded wrongly, still cannot hide a comment from us.
 *
 * Returns { posts, meta, errors }. `meta.failedAccounts` is surfaced, not
 * swallowed: an account whose token expired is a silent hole in coverage and
 * has to reach a human.
 */
async function listCommentedPosts({ minComments = 1, sinceIso = null, limit = 50, budget = null } = {}) {
  const posts = [];
  let cursor = null;
  let meta = null;
  const errors = [];

  for (let page = 0; page < 10; page += 1) {
    const qs = new URLSearchParams({ minComments: String(minComments), limit: String(limit) });
    if (sinceIso) qs.set('since', sinceIso);
    if (cursor) qs.set('cursor', cursor);

    const r = await zernio(`/inbox/comments?${qs.toString()}`, {}, budget);
    if (!r.ok) {
      errors.push({ stage: 'list_commented_posts', status: r.status, error: r.error });
      break;
    }
    const rows = Array.isArray(r.data && r.data.data) ? r.data.data : [];
    // Ad rows live on a different endpoint entirely and are not our organic
    // comment surface. Skip rather than fetch a thread that 400s.
    for (const row of rows) if (!row.isAd) posts.push(row);

    meta = (r.data && r.data.meta) || meta;
    const pg = (r.data && r.data.pagination) || {};
    if (!pg.hasMore || !pg.nextCursor) break;
    cursor = pg.nextCursor;
  }

  const failed = (meta && meta.failedAccounts) || [];
  for (const f of failed) {
    errors.push({
      stage: 'account',
      accountId: f.accountId,
      platform: f.platform,
      username: f.accountUsername,
      code: f.code,
      error: f.error,
    });
  }

  return { posts, meta, errors };
}

/**
 * Every comment on one post, flattened: top-level comments AND their replies,
 * each tagged with parentId so thread shape survives.
 *
 * Facebook inlines at most 10 replies and sets repliesHasMore when there are
 * more; that case pages the rest via the commentId query parameter. Without
 * this, a busy thread silently loses everything past the 10th reply — which is
 * precisely the "no comment goes unseen" rule failing quietly.
 */
async function getPostComments({ postId, accountId, platform, limit = 50, budget = null, maxPages = 5 }) {
  const out = [];
  const errors = [];
  let cursor = null;

  for (let page = 0; page < maxPages; page += 1) {
    const qs = new URLSearchParams({ accountId, limit: String(limit) });
    if (cursor) qs.set('cursor', cursor);
    const r = await zernio(`/inbox/comments/${encodeURIComponent(postId)}?${qs.toString()}`, {}, budget);
    if (!r.ok) {
      errors.push({ stage: 'get_comments', postId, status: r.status, error: r.error });
      break;
    }
    const list = Array.isArray(r.data && r.data.comments) ? r.data.comments : [];
    for (const c of list) {
      out.push({ ...c, parentId: c.parentId || null, platform: c.platform || platform });
      for (const rep of Array.isArray(c.replies) ? c.replies : []) {
        out.push({ ...rep, parentId: rep.parentId || c.id, platform: rep.platform || platform });
      }
      // Facebook caps inline replies at 10 and says so. Go get the rest.
      if (c.repliesHasMore) {
        const deep = await getCommentReplies({ postId, accountId, platform, commentId: c.id, budget });
        out.push(...deep.replies);
        errors.push(...deep.errors);
      }
    }
    const pg = (r.data && r.data.pagination) || {};
    if (!pg.hasMore || !pg.cursor) break;
    cursor = pg.cursor;
  }

  return { comments: out, errors };
}

/** Full reply list for one comment (Facebook, Instagram, Reddit, TikTok). */
async function getCommentReplies({ postId, accountId, platform, commentId, budget = null, maxPages = 5 }) {
  const replies = [];
  const errors = [];
  let cursor = null;

  for (let page = 0; page < maxPages; page += 1) {
    const qs = new URLSearchParams({ accountId, commentId, limit: '50' });
    if (cursor) qs.set('cursor', cursor);
    const r = await zernio(`/inbox/comments/${encodeURIComponent(postId)}?${qs.toString()}`, {}, budget);
    if (!r.ok) {
      errors.push({ stage: 'get_replies', postId, commentId, status: r.status, error: r.error });
      break;
    }
    const list = Array.isArray(r.data && r.data.comments) ? r.data.comments : [];
    for (const rep of list) {
      replies.push({ ...rep, parentId: rep.parentId || commentId, platform: rep.platform || platform });
    }
    const pg = (r.data && r.data.pagination) || {};
    if (!pg.hasMore || !pg.cursor) break;
    cursor = pg.cursor;
  }

  return { replies, errors };
}

// ─── WRITES ───────────────────────────────────────────────────────────────────

/**
 * Post a reply. THIS TALKS TO A REAL PERSON — callers must have checked the
 * ops_flags kill switch and the per-platform cap before getting here.
 *
 * idempotencyKey is not optional in practice. Zernio replays the original
 * response for a repeated key rather than double-posting, which is the only
 * defense against the failure in feedback_never-retry-an-unverified-send: a
 * send that reports failure may have gone out, and retrying it triple-texted a
 * client on 2026-09-11.
 */
async function replyToComment({ postId, accountId, commentId, message, idempotencyKey, budget = null }) {
  const headers = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const body = { accountId, message };
  if (commentId) body.commentId = commentId;

  const r = await zernio(
    `/inbox/comments/${encodeURIComponent(postId)}`,
    { method: 'POST', headers, body: JSON.stringify(body) },
    budget,
  );
  return {
    ok: r.ok,
    status: r.status,
    error: r.error,
    replayed: false,
    commentId: (r.data && r.data.data && r.data.data.commentId) || null,
  };
}

/** Hide a comment. Facebook, Instagram, Threads, X, TikTok(business) only. */
async function hideComment({ postId, commentId, accountId, budget = null }) {
  return zernio(
    `/inbox/comments/${encodeURIComponent(postId)}/${encodeURIComponent(commentId)}/hide`,
    { method: 'POST', body: JSON.stringify({ accountId }) },
    budget,
  );
}

// ─── COMMENT-TO-DM AUTOMATIONS ────────────────────────────────────────────────

async function listAutomations({ profileId = null, budget = null } = {}) {
  const qs = profileId ? `?profileId=${encodeURIComponent(profileId)}` : '';
  const r = await zernio(`/comment-automations${qs}`, {}, budget);
  return { ok: r.ok, status: r.status, error: r.error, automations: (r.data && r.data.automations) || [] };
}

async function getAutomation({ automationId, budget = null }) {
  const r = await zernio(`/comment-automations/${encodeURIComponent(automationId)}`, {}, budget);
  return { ok: r.ok, status: r.status, error: r.error, automation: (r.data && r.data.automation) || null };
}

/**
 * Create an automation.
 *
 * ── THE DANGEROUS PART ──────────────────────────────────────────────────────
 * The API IGNORES isActive:false on create. Verified 2026-09-25: sent it
 * explicitly, got back isActive:true. So every automation is born live and
 * DMing strangers. There is no atomic "create paused".
 *
 * `activate: false` (the default) therefore means: create, immediately PATCH
 * isActive:false, then RE-READ to confirm it actually went inactive. If the
 * deactivation cannot be confirmed, the automation is DELETED rather than left
 * live, and the call reports failure. An automation we cannot prove is off is
 * worse than no automation.
 */
async function createAutomation({
  profileId, accountId, platformPostId = null, postId = null, name, keywords,
  dmMessage, matchMode = 'word', typoTolerance = true, excludeKeywords = [],
  buttons = null, commentReply = null, activate = false, budget = null,
}) {
  if (!DM_AUTOMATION_PLATFORMS.size) throw new Error('unreachable');

  const body = {
    profileId, accountId, name, keywords, dmMessage,
    matchMode, trigger: 'comment',
  };
  // typoTolerance is only meaningful with matchMode 'word'; sending it
  // otherwise is a validation error waiting to happen.
  if (matchMode === 'word') body.typoTolerance = !!typoTolerance;
  if (Array.isArray(excludeKeywords) && excludeKeywords.length) body.excludeKeywords = excludeKeywords;
  if (Array.isArray(buttons) && buttons.length) body.buttons = buttons;
  if (commentReply) body.commentReply = commentReply;

  // platformPostId binds to a post already live. postId (a 24-hex Zernio post
  // id) binds to a not-yet-published post: the automation stays pending and
  // arms itself when that post publishes. Exactly one of them.
  if (postId) body.postId = postId;
  else if (platformPostId) body.platformPostId = platformPostId;

  const created = await zernio('/comment-automations', { method: 'POST', body: JSON.stringify(body) }, budget);
  if (!created.ok) {
    return { ok: false, status: created.status, error: created.error, automation: null };
  }
  const automation = (created.data && created.data.automation) || null;
  const id = automation && automation.id;
  if (!id) {
    return { ok: false, status: created.status, error: 'create_returned_no_id', automation: null };
  }

  if (activate) {
    return { ok: true, status: 200, automation, active: automation.isActive !== false };
  }

  // Close the live window.
  const patched = await zernio(
    `/comment-automations/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify({ isActive: false }) },
    budget,
  );
  const confirm = await zernio(`/comment-automations/${encodeURIComponent(id)}`, {}, budget);
  const nowInactive = confirm.ok
    && confirm.data
    && confirm.data.automation
    && confirm.data.automation.isActive === false;

  if (!nowInactive) {
    await zernio(`/comment-automations/${encodeURIComponent(id)}`, { method: 'DELETE' }, budget);
    return {
      ok: false,
      status: patched.status,
      error: 'could_not_confirm_paused_state_automation_deleted',
      automation: null,
    };
  }

  return { ok: true, status: 200, automation: { ...automation, isActive: false }, active: false };
}

async function updateAutomation({ automationId, patch, budget = null }) {
  const r = await zernio(
    `/comment-automations/${encodeURIComponent(automationId)}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
    budget,
  );
  return { ok: r.ok, status: r.status, error: r.error, automation: (r.data && r.data.automation) || null };
}

async function setAutomationActive({ automationId, active, budget = null }) {
  const r = await updateAutomation({ automationId, patch: { isActive: !!active }, budget });
  if (!r.ok) return r;
  // Trust the read-back, not the write's own success flag.
  const check = await getAutomation({ automationId, budget });
  const confirmed = check.ok && check.automation && check.automation.isActive === !!active;
  return { ...r, confirmed };
}

/** Permanently delete an automation AND its trigger logs. */
async function deleteAutomation({ automationId, budget = null }) {
  const r = await zernio(
    `/comment-automations/${encodeURIComponent(automationId)}`,
    { method: 'DELETE' },
    budget,
  );
  // 404 means it is already gone, which is the state we wanted.
  return { ok: r.ok || r.status === 404, status: r.status, error: r.status === 404 ? null : r.error };
}

/**
 * Trigger logs for one automation: every comment that fired it, who commented,
 * and whether the DM actually landed. THIS IS THE LEAD SOURCE.
 *
 * Also returns `misses` — comments that reached the automation and matched
 * nothing. That is the only signal that a keyword is catching zero, and it is
 * retained for a short window only, so it gets surfaced rather than dropped.
 */
async function getAutomationLogs({ automationId, limit = 100, skip = 0, budget = null }) {
  const qs = new URLSearchParams({ limit: String(limit), skip: String(skip) });
  const r = await zernio(
    `/comment-automations/${encodeURIComponent(automationId)}/logs?${qs.toString()}`,
    {},
    budget,
  );
  return {
    ok: r.ok,
    status: r.status,
    error: r.error,
    logs: (r.data && r.data.logs) || [],
    pagination: (r.data && r.data.pagination) || {},
    misses: (r.data && r.data.misses) || null,
  };
}

async function listAccounts({ budget = null } = {}) {
  const r = await zernio('/accounts', {}, budget);
  return { ok: r.ok, status: r.status, error: r.error, accounts: (r.data && r.data.accounts) || [] };
}

module.exports = {
  ZERNIO_BASE,
  DM_AUTOMATION_PLATFORMS,
  REPLYABLE_PLATFORMS,
  makeBudget,
  zernio,
  listAccounts,
  listCommentedPosts,
  getPostComments,
  getCommentReplies,
  replyToComment,
  hideComment,
  listAutomations,
  getAutomation,
  createAutomation,
  updateAutomation,
  setAutomationActive,
  deleteAutomation,
  getAutomationLogs,
};
