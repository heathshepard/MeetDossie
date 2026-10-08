'use strict';

// api/cron-dispatch-every20.js
//
// AUTO-CONSOLIDATED DISPATCHER (Atlas, 2026-09-16, staging cron-count fix).
// Fan-out entry point for every job that was previously registered in
// vercel.json with its OWN cron entry at schedule "*/20 * * * *". Merged
// because 101 standalone entries exceeded Vercel's 100-item vercel.json
// crons-array schema cap. See api/_lib/cron-multiplex.js for exactly how
// auth, cadence, and failure-isolation are preserved per sub-job.
//
// Members (unchanged handlers, unchanged individual auth checks):
//   - /api/cron-dossie-sign-completion-loop
//   - /api/cron-content-pipeline-review
//   - /api/cron-engagement-review
//   - /api/cron-content-pipeline-promote
//   - /api/cron-post-videos (moved 2026-09-29, from cron-dispatch-every15 —
//     see that file's header for the timeout-flood evidence. This group's
//     vercel.json bucket is maxDuration:300, ample headroom for real Zernio
//     upload work. Gated on status='heath_approved' + scheduled_for<=now()
//     + per-(owner,platform) daily caps, so it is a true no-op on every run
//     with nothing due — safe at any cadence. every20 vs every15 does not
//     meaningfully change Heath's Telegram-approval-to-post latency.
//   - /api/cron-publish-comment-replies (added 2026-09-29, Atlas — the
//     social_comment_replies publisher for 'drafted' rows, same real-Zernio-
//     API reasoning as cron-post-videos above: this group's 300s budget is
//     ample headroom, and NOT cron-dispatch-every15 per explicit instruction
//     given that group's own timeout history. Own internal deadline (20s,
//     MAX_DURATION_S in that file) is far inside this group's per-member
//     share; gated on ops_flags.zernio_comment_replies, default FALSE — a
//     true no-op until Heath turns it on. See that file's header for the
//     full eligibility/escalation contract.
//   - /api/cron-comment-monitor (moved 2026-09-30, from cron-dispatch-
//     every15 — same reasoning as cron-post-videos and cron-publish-comment-
//     replies above, plus a live incident: its own 15s internal deadline was
//     hit mid-scan on a real every15 run, and every15's 30s member ceiling
//     cannot fit the ~80-95s a full Zernio discovery sweep measures at.
//     Own internal deadline (180s, DEADLINE_MS in that file) leaves real
//     headroom inside this group's ~290s member ceiling. Paired with a
//     resumable discovery cursor (cron_comment_monitor_state table) so a
//     tick that still runs long resumes next time instead of re-scanning the
//     same head of the list forever — see that file's header for the full
//     measured numbers.
//
// DO NOT rename member files without updating the require() list below —
// there is no dynamic file-glob here on purpose (explicit > magic for a
// dispatcher that gates money/data-writing jobs).

const { runGroup, isAuthorizedDispatch } = require('./_lib/cron-multiplex.js');

// Single source of truth for this dispatcher's time budget -- used for BOTH
// the per-member deadline default (runGroup's budgetMs below) and Vercel's
// own maxDuration a few lines down, so the two can never drift apart (Atlas,
// 2026-09-29 -- a flat per-member default previously killed 300s-budget
// members like cron-post-videos at 20s; see api/_lib/cron-multiplex.js).
const MAX_DURATION_S = 300;

const HANDLERS = [
  { name: 'cron-dossie-sign-completion-loop', mod: require('./cron-dossie-sign-completion-loop.js') },
  { name: 'cron-content-pipeline-review', mod: require('./cron-content-pipeline-review.js') },
  { name: 'cron-engagement-review', mod: require('./cron-engagement-review.js') },
  { name: 'cron-content-pipeline-promote', mod: require('./cron-content-pipeline-promote.js') },
  { name: 'cron-post-videos', mod: require('./cron-post-videos.js') },
  { name: 'cron-publish-comment-replies', mod: require('./cron-publish-comment-replies.js') },
  { name: 'cron-comment-monitor', mod: require('./cron-comment-monitor.js') },
];

module.exports = async function handler(req, res) {
  // Top-level gate (Atlas, 2026-09-16, post-Quinn-QA fix) — reject BEFORE
  // invoking any sub-job. Each sub-job keeps its own identical check too
  // (defense in depth for anyone hitting it directly); this just stops an
  // unauthenticated caller from fanning out to the whole group at all.
  if (!isAuthorizedDispatch(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const results = await runGroup(req, HANDLERS, { budgetMs: MAX_DURATION_S * 1000 });
  const anyFail = results.some((r) => r.status >= 400);
  return res.status(anyFail ? 207 : 200).json({
    ok: !anyFail,
    dispatcher: 'cron-dispatch-every20',
    schedule: '*/20 * * * *',
    dispatched: HANDLERS.length,
    results,
  });
};

module.exports.config = { maxDuration: MAX_DURATION_S };
