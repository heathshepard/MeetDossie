'use strict';

// api/cron-dispatch-every30.js
//
// AUTO-CONSOLIDATED DISPATCHER (Atlas, 2026-09-16, staging cron-count fix).
// Fan-out entry point for every job that was previously registered in
// vercel.json with its OWN cron entry at schedule "*/30 * * * *". Merged
// because 101 standalone entries exceeded Vercel's 100-item vercel.json
// crons-array schema cap. See api/_lib/cron-multiplex.js for exactly how
// auth, cadence, and failure-isolation are preserved per sub-job.
//
// Members (unchanged handlers, unchanged individual auth checks):
//   - /api/cron-publish-approved
//   - /api/cron-verify-zernio-deliveries
//   - /api/cron-agent-queue-orphan-reset
//   - /api/cron-sage-draft-engagements
//   - /api/cron-showingtime-feedback
//   - /api/cron-support-ticket-alert
//   - /api/cron-tc-reply-approval
//   - /api/cron-comment-opp-approval
//   - /api/cron-retry-unsent-approvals
//
// DO NOT rename member files without updating the require() list below —
// there is no dynamic file-glob here on purpose (explicit > magic for a
// dispatcher that gates money/data-writing jobs).

const { runGroup } = require('./_lib/cron-multiplex.js');

const HANDLERS = [
  { name: 'cron-publish-approved', mod: require('./cron-publish-approved.js') },
  { name: 'cron-verify-zernio-deliveries', mod: require('./cron-verify-zernio-deliveries.js') },
  { name: 'cron-agent-queue-orphan-reset', mod: require('./cron-agent-queue-orphan-reset.js') },
  { name: 'cron-sage-draft-engagements', mod: require('./cron-sage-draft-engagements.js') },
  { name: 'cron-showingtime-feedback', mod: require('./cron-showingtime-feedback.js') },
  { name: 'cron-support-ticket-alert', mod: require('./cron-support-ticket-alert.js') },
  { name: 'cron-tc-reply-approval', mod: require('./cron-tc-reply-approval.js') },
  { name: 'cron-comment-opp-approval', mod: require('./cron-comment-opp-approval.js') },
  { name: 'cron-retry-unsent-approvals', mod: require('./cron-retry-unsent-approvals.js') },
];

module.exports = async function handler(req, res) {
  const results = await runGroup(req, HANDLERS);
  const anyFail = results.some((r) => r.status >= 400);
  return res.status(anyFail ? 207 : 200).json({
    ok: !anyFail,
    dispatcher: 'cron-dispatch-every30',
    schedule: '*/30 * * * *',
    dispatched: HANDLERS.length,
    results,
  });
};

module.exports.config = { maxDuration: 70 };
