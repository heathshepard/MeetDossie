'use strict';

// api/cron-publish-comment-replies.js
// =============================================================================
// THE MISSING PUBLISHER for social_comment_replies drafted-but-never-posted
// rows, via the Zernio API. Heath authorized this build directly, 2026-09-29.
//
// ─── THE GAP THIS CLOSES ──────────────────────────────────────────────────────
// Measured against prod Supabase, 2026-09-29: social_comment_replies held 39
// rows and NOT ONE had ever posted. cron-comment-reply-draft.js drafts a reply
// and files it as reply_status='drafted' (or 'held' if it needs a human, or
// 'flagged' if the model called it hostile/empty). A publisher already
// existed — api/cron-post-comment-replies.js — but it only ever posts
// reply_status='approved', and the only door to 'approved' is Heath tapping
// "Approve" on a DossieMarketingBot card. Per Heath, 2026-09-28
// (feedback_daily-social-ops-are-coles-job.md): "Telegram... I get 1000
// messages a day... that needs to be your job entirely." Nothing ever taps
// Approve, so 'drafted' rows sit forever and the existing publisher has
// nothing to drain. This file posts DIRECTLY off 'drafted' — no Telegram tap
// in the loop — with its own independent safety gates below, because
// removing the human tap means the automated gates ARE the safety now.
//
// ─── SHARED INFRASTRUCTURE WITH THE EXISTING (approved-only) PUBLISHER ───────
// Both publishers write to the same table and must never be able to
// double-post or blow past one shared daily budget:
//   - Same ops_flags kill switch: 'zernio_comment_replies'. Default FALSE.
//     Heath turns it on when he's reviewed a dry run and is ready for this
//     pipeline to actually post. Until then this cron posts nothing, ever,
//     regardless of schedule.
//   - Same comment-caps.js budget key: 'zernio_comment_reply' (20/day,
//     5-min floor). One shared counter, so this cron and
//     cron-post-comment-replies.js can never together exceed the cap either
//     one was scoped for alone.
//   - No row collision: this cron's WHERE clause is reply_status='drafted';
//     the other's is reply_status='approved'. A row can be in exactly one of
//     those states at a time, and this cron claims (PATCH guarded on the
//     status it read) before ever calling Zernio, so two overlapping runs of
//     EITHER cron can never both act on the same row.
//
// ─── ELIGIBILITY — four independent, individually-logged gates ──────────────
// 1. STATUS  reply_status='drafted', reply_text non-empty, is_spam!=true.
//    'held'/'flagged'/'skipped_spam' are NEVER eligible — 'held' means the
//    draft pipeline already decided a human needs to look at it; it is not a
//    backlog to drain (fb-engagement-thread-close-policy.md).
// 2. AGE     comment_created_at must be within AGE_CUTOFF_DAYS (14). Roughly
//    half this queue predates 2026. Replying to a two-year-old comment reads
//    as a malfunctioning bot. Expired rows are marked reply_status='expired'
//    with a reason — NEVER deleted, NEVER posted.
// 3. ESCALATION  a deterministic, defense-in-depth re-check on top of the
//    draft-time model classification (scripts/_lib/auto-reply-risk-
//    classifier.js + scripts/_lib/auto-reply-content-gates.js, which already
//    ran before a row could reach 'drafted' at all). A publish gate must not
//    simply trust an upstream invariant it can re-verify for near-zero cost —
//    so this file re-scans comment+reply text for pricing, demo requests,
//    legal/compliance language, a named client or specific listing, and
//    hostile/negative/complaint language, PER
//    fb-engagement-thread-close-policy.md and
//    feedback_daily-social-ops-are-coles-job.md. Any match routes the row to
//    reply_status='held' instead of posting — same terminal state the
//    drafter itself uses for "needs Heath's judgment." Err toward escalation:
//    a missed reply costs nothing; a wrong public reply costs Heath his
//    license's reputation.
// 4. RATE CAPS  scripts/_lib/comment-caps.js — same shared platform/day cap
//    and min-gap logic api/cron-post-comment-replies.js already uses, PLUS
//    MAX_PER_RUN below as this run's own ceiling.
//
// ─── POSTING MECHANISM — PROBED, NOT GUESSED ─────────────────────────────────
// Zernio's official OpenAPI spec (fetched live 2026-09-29, operationId
// `replyToInboxPost`) confirms:
//   POST /v1/inbox/comments/{postId}
//   body: { accountId (required), message (required), commentId (optional —
//          "Reply to specific comment") }
// This is a PUBLIC reply, threaded under the comment when commentId is sent.
// It is the SAME endpoint api/_lib/zernio-comments.js's replyToComment()
// already implements (that file is off-limits for edits here, so this cron
// reuses it unchanged). A separate, DM-only endpoint exists —
// POST /v1/inbox/comments/{postId}/{commentId}/private-reply
// ("Send a direct message to the author of a comment... Instagram and
// Facebook only") — and is NOT used here; a public reply and a DM are
// different actions with different visibility and this cron only ever does
// the former. Read-only confirmation against a live row (GET
// /v1/inbox/comments/{postId}?accountId=...&commentId=...) returned
// canReply:true on a real comment without touching a real person.
//
// ─── ONE ATTEMPT, NEVER A RETRY ──────────────────────────────────────────────
// feedback_never-retry-an-unverified-send.md: a send that reports failure may
// have gone out anyway. A row that errors goes straight to 'post_failed' and
// STOPS — it is never re-queued automatically. The Idempotency-Key makes
// Zernio replay rather than double-post if the failure was only a lost
// response, but the stop rule does not depend on that working.
//
// ─── DRY RUN — THE ONLY MODE THIS SHIPS IN TODAY ─────────────────────────────
// Heath's explicit instruction, 2026-09-29: nobody has reviewed these 39
// drafts and several are years old, so the FIRST run of this file must not
// send anything to a real person. dryRun=1 (or ops_flags.zernio_comment_replies
// still FALSE, its current live value) computes and returns the full plan —
// exactly which rows would post, their reply text, and their age — and
// writes NOTHING, not even the 'expired' housekeeping marks. Only a REAL run
// (flag on, dryRun not set) marks expired/held rows, which is deliberate:
// the very first live tick after Heath flips the flag is also the first time
// this file is allowed to write anything at all.
//
// ─── WIRING ───────────────────────────────────────────────────────────────────
// Member of cron-dispatch-every20 (NOT every15 — that group already carries
// cron-comment-monitor.js's own timeout history, see that dispatcher's
// header). cron-post-videos.js was moved into every20 for the same reason
// this job belongs there: real outbound-API work needs more than every15's
// tight budget. MAX_DURATION_S below is this job's OWN internal wall-clock
// ceiling inside every20's shared 300s group window — this file has no
// standalone vercel.json entry and therefore no maxDuration of its own.
//
// Owner: Atlas, 2026-09-29.
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { replyToComment, makeBudget } = require('./_lib/zernio-comments.js');
const caps = require('../scripts/_lib/comment-caps.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const OPS_FLAG = 'zernio_comment_replies'; // shared kill switch, see header
const CAP_KEY = 'zernio_comment_reply'; // shared daily budget, see header
const MAX_PER_RUN = 5;
const AGE_CUTOFF_DAYS = 14;

// This job's own wall-clock budget as a cron-dispatch-every20 member (see
// Wiring note above) — not Vercel's maxDuration, which belongs to the
// dispatcher, not to this file.
const MAX_DURATION_S = 20;
const DEADLINE_MS = MAX_DURATION_S * 1000;
const FETCH_TIMEOUT_MS = 6000;

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
    return { ok: false, status: 0, data: null, error: String((err && err.message) || err), raw: '' };
  }
}

/** comment-caps.js wants a fetcher with its own (path, init) shape. */
const sbFetch = (path, init) => sb(path.replace(/^\/rest\/v1\//, ''), init);

async function flagEnabled() {
  const r = await sb(`ops_flags?key=eq.${OPS_FLAG}&select=enabled`);
  if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) return false;
  return r.data[0].enabled === true;
}

// ─── Gate 1: status ───────────────────────────────────────────────────────────
function checkStatusEligible(row) {
  if (row.reply_status !== 'drafted') return { pass: false, reason: `reply_status:${row.reply_status}` };
  if (!String(row.reply_text || '').trim()) return { pass: false, reason: 'empty_reply_text' };
  if (row.is_spam === true) return { pass: false, reason: 'is_spam' };
  return { pass: true };
}

// ─── Gate 2: age ──────────────────────────────────────────────────────────────
function checkAgeEligible(row, ageCutoffDays = AGE_CUTOFF_DAYS) {
  if (!row.comment_created_at) return { pass: false, reason: 'no_comment_created_at', ageDays: null };
  const ageDays = (Date.now() - new Date(row.comment_created_at).getTime()) / 86400000;
  if (!Number.isFinite(ageDays)) return { pass: false, reason: 'unparseable_comment_created_at', ageDays: null };
  if (ageDays > ageCutoffDays) {
    return { pass: false, reason: `expired:${ageDays.toFixed(1)}d>${ageCutoffDays}d`, ageDays };
  }
  return { pass: true, ageDays };
}

// ─── Gate 3: escalation guard ─────────────────────────────────────────────────
// Deterministic, cheap (no model call), defense-in-depth on top of the
// draft-time classification. Every category is separately named so a hit is
// diagnosable, not just "escalated:true". Per
// fb-engagement-thread-close-policy.md + feedback_daily-social-ops-are-coles-
// job.md: pricing, demo requests, legal/contractual language, a named client
// or specific listing, and hostile/negative/complaint language always
// escalate, never auto-post. Deliberately generous (false-positive-prone
// over false-negative-prone) — an idiomatic use of a word like "liability"
// holding a row for a human costs nothing; a wrong public reply does not.
const ESCALATION_PATTERNS = {
  pricing: /\$\s?\d|\b(price|pricing|cost|costs?|discount|refund|billing|how much)\b/i,
  demo_request: /\b(demo|trial|walk[\s-]?through|see it in action|try it out)\b/i,
  legal_or_compliance: /\b(contract|legal|liab(?:le|ility)|trec|earnest money|lawsuit|attorney|breach|comply|compliance|license)\b/i,
  named_client_or_listing: /\b\d{1,6}\s+\w+\s+(street|st|ave|avenue|rd|road|dr|drive|ln|lane|blvd|way|ct|court)\b|\bmls\s?#?\d|\bmy (client|buyer|seller|listing)\b/i,
  hostile_negative_or_complaint: /\b(scam|hate|terrible|awful|worst|sucks?|broken|doesn.?t work|rip[\s-]?off|fraud|fake|unsubscribe|garbage|joke)\b/i,
};

function checkEscalationGuard(row) {
  const text = `${row.original_comment || ''}\n${row.reply_text || ''}`;
  const matched = [];
  for (const [category, re] of Object.entries(ESCALATION_PATTERNS)) {
    if (re.test(text)) matched.push(category);
  }
  // The draft pipeline should already guarantee escalated=false on every
  // 'drafted' row (cron-comment-reply-draft.js only reaches 'drafted' when
  // its own model classifier said eligible AND the content gates passed) —
  // but a publish gate must check its own invariant, not assume one set by
  // a different file three steps upstream ever stays true.
  if (row.escalated === true) matched.push('draft_time_escalated_flag');
  return { pass: matched.length === 0, matched };
}

async function handler(req, res) {
  const handlerStart = Date.now();
  const deadlineAt = handlerStart + DEADLINE_MS;
  const auth = req.headers.authorization || req.headers.Authorization || '';
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const isManualAuth = !!CRON_SECRET && auth === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }
  if (!process.env.ZERNIO_API_KEY) {
    return res.status(503).json({ ok: false, error: 'zernio_env_missing' });
  }

  // dryRun reports exactly what WOULD happen (post / hold / expire) and
  // writes nothing — not even the housekeeping expired/held marks. This is
  // how the pipeline gets proven before Heath ever flips the ops flag.
  const dryRun = String(req.query.dryRun || '') === '1';

  const enabled = await flagEnabled();
  if (!enabled && !dryRun) {
    const queued = await sb(`social_comment_replies?reply_status=eq.drafted&is_spam=not.is.true&select=id`);
    return res.status(200).json({
      ok: true,
      posted: 0,
      disabled: true,
      flag: OPS_FLAG,
      drafted_waiting: Array.isArray(queued.data) ? queued.data.length : 0,
      note: `${OPS_FLAG} is off. Nothing posts. Drafted replies queue until Heath enables it (same flag api/cron-post-comment-replies.js already gates on).`,
    });
  }

  const pending = await sb(
    'social_comment_replies?reply_status=eq.drafted&is_spam=not.is.true'
    + '&select=id,reply_status,is_spam,platform,account_id,external_post_id,comment_external_id,reply_text,commenter_name,'
    + 'original_comment,comment_created_at,escalated,attempt_count'
    + `&order=comment_created_at.asc&limit=200`,
  );
  if (!pending.ok) return res.status(500).json({ ok: false, error: `query_failed:${pending.status}` });
  const rows = Array.isArray(pending.data) ? pending.data : [];

  if (rows.length === 0) {
    return res.status(200).json({ ok: true, posted: 0, note: 'no drafted replies waiting' });
  }

  const budget = makeBudget(20);
  let posted = 0;
  let expired = 0;
  let held = 0;
  const skipped = [];
  const errors = [];
  const plan = []; // dry-run only

  for (const row of rows) {
    if (Date.now() >= deadlineAt) {
      skipped.push({ id: row.id, reason: 'deadline_hit' });
      break;
    }

    // Gate 1 — status. Belt-and-suspenders: the query above already filters
    // reply_status=drafted&is_spam=false, but a row-level check keeps this
    // logged and testable independent of the query string.
    const statusCheck = checkStatusEligible(row);
    if (!statusCheck.pass) {
      skipped.push({ id: row.id, gate: 'status', reason: statusCheck.reason });
      continue;
    }

    // Gate 2 — age. Expired rows are marked, never posted, never deleted.
    const ageCheck = checkAgeEligible(row);
    if (!ageCheck.pass) {
      if (dryRun) {
        plan.push({
          id: row.id, platform: row.platform, action: 'would_mark_expired',
          reason: ageCheck.reason, ageDays: ageCheck.ageDays,
          commentCreatedAt: row.comment_created_at, replyText: row.reply_text,
        });
      } else {
        await sb(`social_comment_replies?id=eq.${row.id}&reply_status=eq.drafted`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ reply_status: 'expired', error_message: ageCheck.reason }),
        });
      }
      expired += 1;
      continue;
    }

    // Gate 3 — escalation guard. A match holds the row for Heath, never posts.
    const escCheck = checkEscalationGuard(row);
    if (!escCheck.pass) {
      if (dryRun) {
        plan.push({
          id: row.id, platform: row.platform, action: 'would_hold_escalated',
          matched: escCheck.matched, ageDays: ageCheck.ageDays,
          commentCreatedAt: row.comment_created_at, replyText: row.reply_text,
        });
      } else {
        await sb(`social_comment_replies?id=eq.${row.id}&reply_status=eq.drafted`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            reply_status: 'held',
            escalated: true,
            escalation_reason: `publish_gate:${escCheck.matched.join(',')}`,
          }),
        });
      }
      held += 1;
      continue;
    }

    // Gate 4 — rate caps. Shared budget with api/cron-post-comment-replies.js
    // (same CAP_KEY, same table) so the two publishers can never together
    // exceed the one ceiling either was scoped for alone.
    if (plan.filter((p) => p.action === 'would_post').length + posted >= MAX_PER_RUN) {
      skipped.push({ id: row.id, reason: `run_cap:${MAX_PER_RUN}` });
      break;
    }
    const allowed = await caps.canComment(CAP_KEY, sbFetch);
    if (!allowed.allowed) { skipped.push({ id: row.id, reason: allowed.reason }); break; }
    const gap = await caps.minGapElapsed(CAP_KEY, sbFetch, 'social_comment_replies', 'posted_at', row.platform);
    if (!gap.elapsed) {
      skipped.push({ id: row.id, reason: `min_gap:${Math.round(gap.ageMin)}<${gap.gapMin}min` });
      break;
    }

    if (!row.account_id || !row.external_post_id || !row.comment_external_id) {
      if (!dryRun) {
        await sb(`social_comment_replies?id=eq.${row.id}&reply_status=eq.drafted`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ reply_status: 'post_failed', error_message: 'row missing account_id/post id/comment id' }),
        });
      }
      errors.push({ id: row.id, error: 'incomplete_row' });
      continue;
    }

    if (dryRun) {
      plan.push({
        id: row.id,
        platform: row.platform,
        action: 'would_post',
        to: row.commenter_name,
        postId: row.external_post_id,
        commentId: row.comment_external_id,
        ageDays: Math.round(ageCheck.ageDays * 10) / 10,
        commentCreatedAt: row.comment_created_at,
        comment: row.original_comment,
        replyText: row.reply_text,
      });
      continue;
    }

    // Claim FIRST, guarded on the status just read, so two overlapping runs
    // (of this cron, or a manual trigger racing the scheduled tick) can
    // never both post the same reply.
    const claim = await sb(`social_comment_replies?id=eq.${row.id}&reply_status=eq.drafted`, {
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
      // Distinct prefix from cron-post-comment-replies.js's `zcr-` keys —
      // different rows in practice (disjoint status filters) but a
      // dedicated prefix costs nothing and rules out any accidental clash.
      idempotencyKey: `zcpr-${row.id}`,
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
      posted += 1;
    } else {
      // ONE attempt. Never auto-requeued — the send may have landed anyway
      // (feedback_never-retry-an-unverified-send.md).
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

  // `posted` feeds cron-telemetry's outcome stamp (withOutcome() in
  // api/_lib/cron-telemetry.js) — a run that posts nothing while eligible
  // rows exist shows as outcome='zero', not indistinguishable from success.
  return res.status(200).json({
    ok: true,
    posted,
    would_post: dryRun ? plan.filter((p) => p.action === 'would_post').length : undefined,
    would_expire: dryRun ? plan.filter((p) => p.action === 'would_mark_expired').length : undefined,
    would_hold_escalated: dryRun ? plan.filter((p) => p.action === 'would_hold_escalated').length : undefined,
    expired,
    held,
    considered: rows.length,
    dry_run: dryRun,
    plan: dryRun ? plan : undefined,
    skipped,
    error_count: errors.length,
    errors: errors.slice(0, 5),
    duration_ms: Date.now() - handlerStart,
  });
}

module.exports = withTelemetry('cron-publish-comment-replies', handler);
module.exports.handler = handler;
module.exports.checkStatusEligible = checkStatusEligible;
module.exports.checkAgeEligible = checkAgeEligible;
module.exports.checkEscalationGuard = checkEscalationGuard;
module.exports.ESCALATION_PATTERNS = ESCALATION_PATTERNS;
module.exports.AGE_CUTOFF_DAYS = AGE_CUTOFF_DAYS;
module.exports.MAX_PER_RUN = MAX_PER_RUN;
