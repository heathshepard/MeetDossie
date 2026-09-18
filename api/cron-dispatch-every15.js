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
// DO NOT rename member files without updating the require() list below —
// there is no dynamic file-glob here on purpose (explicit > magic for a
// dispatcher that gates money/data-writing jobs).

const { runGroup, isAuthorizedDispatch } = require('./_lib/cron-multiplex.js');

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
  const results = await runGroup(req, HANDLERS);
  const anyFail = results.some((r) => r.status >= 400);
  return res.status(anyFail ? 207 : 200).json({
    ok: !anyFail,
    dispatcher: 'cron-dispatch-every15',
    schedule: '*/15 * * * *',
    dispatched: HANDLERS.length,
    results,
  });
};

module.exports.config = { maxDuration: 40 };
