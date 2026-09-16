'use strict';

// api/cron-dispatch-every5.js
//
// AUTO-CONSOLIDATED DISPATCHER (Atlas, 2026-09-16, staging cron-count fix).
// Fan-out entry point for every job that was previously registered in
// vercel.json with its OWN cron entry at schedule "*/5 * * * *". Merged
// because 101 standalone entries exceeded Vercel's 100-item vercel.json
// crons-array schema cap. See api/_lib/cron-multiplex.js for exactly how
// auth, cadence, and failure-isolation are preserved per sub-job.
//
// Members (unchanged handlers, unchanged individual auth checks):
//   - /api/alert-health
//   - /api/cron-pc-heartbeat-check
//   - /api/cron-staging-watcher
//   - /api/cron-send-outbound-emails
//   - /api/cron-agent-queue-tick
//   - /api/cron-auto-reply-veto-check
//
// DO NOT rename member files without updating the require() list below —
// there is no dynamic file-glob here on purpose (explicit > magic for a
// dispatcher that gates money/data-writing jobs).

const { runGroup } = require('./_lib/cron-multiplex.js');

const HANDLERS = [
  { name: 'alert-health', mod: require('./alert-health.js') },
  { name: 'cron-pc-heartbeat-check', mod: require('./cron-pc-heartbeat-check.js') },
  { name: 'cron-staging-watcher', mod: require('./cron-staging-watcher.js') },
  { name: 'cron-send-outbound-emails', mod: require('./cron-send-outbound-emails.js') },
  { name: 'cron-agent-queue-tick', mod: require('./cron-agent-queue-tick.js') },
  { name: 'cron-auto-reply-veto-check', mod: require('./cron-auto-reply-veto-check.js') },
];

module.exports = async function handler(req, res) {
  const results = await runGroup(req, HANDLERS);
  const anyFail = results.some((r) => r.status >= 400);
  return res.status(anyFail ? 207 : 200).json({
    ok: !anyFail,
    dispatcher: 'cron-dispatch-every5',
    schedule: '*/5 * * * *',
    dispatched: HANDLERS.length,
    results,
  });
};

module.exports.config = { maxDuration: 70 };
