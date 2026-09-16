'use strict';

// api/cron-dispatch-daily-1200.js
//
// AUTO-CONSOLIDATED DISPATCHER (Atlas, 2026-09-16, staging cron-count fix).
// Fan-out entry point for every job that was previously registered in
// vercel.json with its OWN cron entry at schedule "0 12 * * *". Merged
// because 101 standalone entries exceeded Vercel's 100-item vercel.json
// crons-array schema cap. See api/_lib/cron-multiplex.js for exactly how
// auth, cadence, and failure-isolation are preserved per sub-job.
//
// Members (unchanged handlers, unchanged individual auth checks):
//   - /api/cron-followup
//   - /api/cron-morning-brief
//   - /api/cron-customer-morning-brief
//   - /api/cron-social-digest
//
// DO NOT rename member files without updating the require() list below —
// there is no dynamic file-glob here on purpose (explicit > magic for a
// dispatcher that gates money/data-writing jobs).

const { runGroup } = require('./_lib/cron-multiplex.js');

const HANDLERS = [
  { name: 'cron-followup', mod: require('./cron-followup.js') },
  { name: 'cron-morning-brief', mod: require('./cron-morning-brief.js') },
  { name: 'cron-customer-morning-brief', mod: require('./cron-customer-morning-brief.js') },
  { name: 'cron-social-digest', mod: require('./cron-social-digest.js') },
];

module.exports = async function handler(req, res) {
  const results = await runGroup(req, HANDLERS);
  const anyFail = results.some((r) => r.status >= 400);
  return res.status(anyFail ? 207 : 200).json({
    ok: !anyFail,
    dispatcher: 'cron-dispatch-daily-1200',
    schedule: '0 12 * * *',
    dispatched: HANDLERS.length,
    results,
  });
};

module.exports.config = { maxDuration: 20 };
