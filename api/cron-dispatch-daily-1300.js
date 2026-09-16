'use strict';

// api/cron-dispatch-daily-1300.js
//
// AUTO-CONSOLIDATED DISPATCHER (Atlas, 2026-09-16, staging cron-count fix).
// Fan-out entry point for every job that was previously registered in
// vercel.json with its OWN cron entry at schedule "0 13 * * *". Merged
// because 101 standalone entries exceeded Vercel's 100-item vercel.json
// crons-array schema cap. See api/_lib/cron-multiplex.js for exactly how
// auth, cadence, and failure-isolation are preserved per sub-job.
//
// Members (unchanged handlers, unchanged individual auth checks):
//   - /api/cron-calculator-deadline-reminders
//   - /api/cron-email-digest
//   - /api/cron-pipeline-health
//   - /api/cron-render-skits
//   - /api/cron-morning-ops-digest
//
// DO NOT rename member files without updating the require() list below —
// there is no dynamic file-glob here on purpose (explicit > magic for a
// dispatcher that gates money/data-writing jobs).

const { runGroup } = require('./_lib/cron-multiplex.js');

const HANDLERS = [
  { name: 'cron-calculator-deadline-reminders', mod: require('./cron-calculator-deadline-reminders.js') },
  { name: 'cron-email-digest', mod: require('./cron-email-digest.js') },
  { name: 'cron-pipeline-health', mod: require('./cron-pipeline-health.js') },
  { name: 'cron-render-skits', mod: require('./cron-render-skits.js') },
  { name: 'cron-morning-ops-digest', mod: require('./cron-morning-ops-digest.js') },
];

module.exports = async function handler(req, res) {
  const results = await runGroup(req, HANDLERS);
  const anyFail = results.some((r) => r.status >= 400);
  return res.status(anyFail ? 207 : 200).json({
    ok: !anyFail,
    dispatcher: 'cron-dispatch-daily-1300',
    schedule: '0 13 * * *',
    dispatched: HANDLERS.length,
    results,
  });
};

module.exports.config = { maxDuration: 40 };
