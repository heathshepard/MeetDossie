'use strict';

// api/cron-dispatch-every15.js
//
// AUTO-CONSOLIDATED DISPATCHER (Atlas, 2026-09-16, staging cron-count fix).
// Fan-out entry point for every job that was previously registered in
// vercel.json with its OWN cron entry at schedule "*/15 * * * *". Merged
// because 101 standalone entries exceeded Vercel's 100-item vercel.json
// crons-array schema cap. See api/_lib/cron-multiplex.js for exactly how
// auth, cadence, and failure-isolation are preserved per sub-job.
//
// Members (unchanged handlers, unchanged individual auth checks):
//   - /api/cron-followup-check
//   - /api/cron-send-engagement-approvals
//   - /api/cron-relevance-watcher
//   - /api/cron-email-to-dossier
//   - /api/cron-esign-events
//   - /api/cron-merge-queue-backfill
//   - /api/cron-comment-monitor
//   - /api/cron-support-ticket-triage   (added 2026-09-18)
//
// cron-post-videos MOVED OUT AGAIN (Atlas, 2026-09-29) to cron-dispatch-
// every20 — this group's own vercel.json bucket (api/{cron-dispatch-daily-
// 1300,cron-dispatch-every15}.js) is capped at maxDuration:40, and Vercel
// logs confirm this dispatcher was hitting "Task timed out after 40 seconds"
// on 32/32 sampled runs over 8h (the ~500-email flood). In 26 of those 32
// runs cron-post-videos itself logged completion in well under 40s
// ("nothing to post"), so it was not reliably the hang — but it's still the
// one member here doing real outbound work (Zernio uploads across multiple
// platforms), and 2026-09-28's move put it in the group with the LEAST
// headroom of any bucket it could have landed in. every20 shares vercel.json's
// 300s bucket, which is a strict improvement in both directions: more time
// for post-videos' own Zernio calls, and it no longer contends for the 8
// remaining every15 members' already-tight 40s budget. Approval-latency
// concern from 2026-09-28 (why it left daily-1330 in the first place) is
// unaffected — 20 vs 15 minutes is not a meaningfully different wait.
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
const MAX_DURATION_S = 40;

const HANDLERS = [
  { name: 'cron-followup-check', mod: require('./cron-followup-check.js') },
  { name: 'cron-send-engagement-approvals', mod: require('./cron-send-engagement-approvals.js') },
  { name: 'cron-relevance-watcher', mod: require('./cron-relevance-watcher.js') },
  { name: 'cron-email-to-dossier', mod: require('./cron-email-to-dossier.js') },
  { name: 'cron-esign-events', mod: require('./cron-esign-events.js') },
  { name: 'cron-merge-queue-backfill', mod: require('./cron-merge-queue-backfill.js') },
  { name: 'cron-comment-monitor', mod: require('./cron-comment-monitor.js') },
  { name: 'cron-support-ticket-triage', mod: require('./cron-support-ticket-triage.js') },
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
    dispatcher: 'cron-dispatch-every15',
    schedule: '*/15 * * * *',
    dispatched: HANDLERS.length,
    results,
  });
};

module.exports.config = { maxDuration: MAX_DURATION_S };
