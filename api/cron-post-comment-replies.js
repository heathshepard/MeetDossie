'use strict';

// api/cron-post-comment-replies.js
// =============================================================================
// Posts Heath-APPROVED replies to inbound comments, via the Zernio API.
//
// THIS IS THE ONLY FILE IN THIS PIPELINE THAT TALKS TO A REAL PERSON, and it
// is wrapped in four independent gates. Any one of them says no and nothing
// goes out:
//
//   1. ops_flags.zernio_comment_replies must be enabled. Default FALSE.
//      Heath turns it on. Until then this cron drains nothing and says so.
//   2. reply_status must be 'approved' — set only by Heath's explicit tap in
//      Telegram (api/telegram-webhook.js, zcr_approve). There is no
//      approve-by-default, no veto window, no timeout-to-send.
//   3. escalated rows are refused outright, even if somehow approved. A
//      pricing question or a demo request is Heath's to answer in person
//      (fb-engagement-thread-close-policy.md).
//   4. Per-platform caps and min-gap from scripts/_lib/comment-caps.js
//      (budget key 'zernio_comment_reply', 20/day, 5-min floor).
//
// ─── ONE ATTEMPT, NEVER A RETRY ──────────────────────────────────────────────
// feedback_never-retry-an-unverified-send.md: a send that reports failure may
// have gone out. Retrying one triple-texted a client on 2026-09-11. So a row
// that errors goes to 'post_failed' and STOPS. It is never re-queued
// automatically. The Idempotency-Key makes Zernio replay rather than
// double-post if the failure was only a lost response, but the stop rule does
// not depend on that working.
//
// Schedule: */20. Owner: Atlas, 2026-09-25.
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { replyToComment, makeBudget } = require('./_lib/zernio-comments.js');
const caps = require('../scripts/_lib/comment-caps.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const OPS_FLAG = 'zernio_comment_replies';
const CAP_KEY = 'zernio_comment_reply';
const MAX_PER_RUN = 3;

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

/** comment-caps.js wants a fetcher with its own (path, init) shape. */
const sbFetch = (path, init) => sb(path.replace(/^\/rest\/v1\//, ''), init);

async function flagEnabled() {
  const r = await sb(`ops_flags?key=eq.${OPS_FLAG}&select=enabled`);
  if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) return false;
  return r.data[0].enabled === true;
}

async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  // dryRun reports exactly what WOULD go out and posts nothing. This is how
  // the pipeline is proven before the flag is ever flipped.
  const dryRun = String(req.query.dryRun || '') === '1';

  const enabled = await flagEnabled();
  if (!enabled && !dryRun) {
    const queued = await sb('social_comment_replies?reply_status=eq.approved&escalated=is.false&select=id');
    return res.status(200).json({
      ok: true,
      replied: 0,
      disabled: true,
      flag: OPS_FLAG,
      approved_waiting: Array.isArray(queued.data) ? queued.data.length : 0,
      note: `${OPS_FLAG} is off. Nothing posts. Approved replies queue until Heath enables it.`,
    });
  }

  const pending = await sb(
    'social_comment_replies?reply_status=eq.approved&escalated=is.false'
    + '&select=id,platform,account_id,external_post_id,comment_external_id,reply_text,commenter_name,attempt_count'
    + `&order=approved_at.asc&limit=${MAX_PER_RUN}`,
  );
  if (!pending.ok) return res.status(500).json({ ok: false, error: `query_failed:${pending.status}` });
  const rows = Array.isArray(pending.data) ? pending.data : [];

  if (rows.length === 0) {
    return res.status(200).json({ ok: true, replied: 0, note: 'no approved replies waiting' });
  }

  const budget = makeBudget(20);
  let replied = 0;
  const skipped = [];
  const errors = [];
  const plan = [];

  for (const row of rows) {
    const allowed = await caps.canComment(CAP_KEY, sbFetch);
    if (!allowed.allowed) { skipped.push({ id: row.id, reason: allowed.reason }); break; }

    const gap = await caps.minGapElapsed(CAP_KEY, sbFetch, 'social_comment_replies', 'posted_at', row.platform);
    if (!gap.elapsed) {
      skipped.push({ id: row.id, reason: `min_gap:${Math.round(gap.ageMin)}<${gap.gapMin}min` });
      break;
    }

    if (!row.account_id || !row.external_post_id || !row.comment_external_id || !row.reply_text) {
      await sb(`social_comment_replies?id=eq.${row.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ reply_status: 'post_failed', error_message: 'row missing account_id/post id/comment id/text' }),
      });
      errors.push({ id: row.id, error: 'incomplete_row' });
      continue;
    }

    if (dryRun) {
      plan.push({
        id: row.id,
        platform: row.platform,
        to: row.commenter_name,
        postId: row.external_post_id,
        commentId: row.comment_external_id,
        text: row.reply_text,
      });
      continue;
    }

    // Claim the row FIRST, guarded on the status we read, so two overlapping
    // runs can never both post the same reply.
    const claim = await sb(`social_comment_replies?id=eq.${row.id}&reply_status=eq.approved`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ reply_status: 'posting', attempt_count: (row.attempt_count || 0) + 1 }),
    });
    if (!claim.ok || !Array.isArray(claim.data) || claim.data.length === 0) continue;

    const result = await replyToComment({
      postId: row.external_post_id,
      accountId: row.account_id,
      commentId: row.comment_external_id,
      message: row.reply_text,
      // Stable per comment, so a replayed request replays rather than duplicates.
      idempotencyKey: `zcr-${row.id}`,
      budget,
    });

    if (result.ok) {
      await sb(`social_comment_replies?id=eq.${row.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          reply_status: 'posted',
          reply_external_id: result.commentId,
          posted_at: new Date().toISOString(),
          error_message: null,
        }),
      });
      await caps.recordComment(CAP_KEY, sbFetch);
      replied += 1;
    } else {
      // ONE attempt. Never auto-requeued — the send may have landed.
      await sb(`social_comment_replies?id=eq.${row.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          reply_status: 'post_failed',
          error_message: `zernio ${result.status}: ${String(result.error || '').slice(0, 300)}`,
        }),
      });
      errors.push({ id: row.id, status: result.status, error: result.error });
    }
  }

  return res.status(200).json({
    ok: true,
    replied,
    considered: rows.length,
    dry_run: dryRun,
    would_post: dryRun ? plan : undefined,
    skipped,
    error_count: errors.length,
    errors: errors.slice(0, 5),
  });
}

module.exports = withTelemetry('cron-post-comment-replies', handler);
module.exports.handler = handler;
