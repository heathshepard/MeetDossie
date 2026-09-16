'use strict';

// api/cron-dispatch-daily-1000.js
//
// AUTO-CONSOLIDATED DISPATCHER (Atlas, 2026-09-16, staging cron-count fix).
// Fan-out entry point for every job that was previously registered in
// vercel.json with its OWN cron entry at schedule "0 10 * * *". Merged
// because 101 standalone entries exceeded Vercel's 100-item vercel.json
// crons-array schema cap. See api/_lib/cron-multiplex.js for exactly how
// auth, cadence, and failure-isolation are preserved per sub-job.
//
// Members (unchanged handlers, unchanged individual auth checks):
//   - /api/cron-video-approval
//   - /api/cron-cron-fire-verifier
//   - /api/cron-dossie-full-diagnostic
//   - /api/cron-self-improvement-daily
//   - /api/cron-trending-audio-scan
//
// DO NOT rename member files without updating the require() list below —
// there is no dynamic file-glob here on purpose (explicit > magic for a
// dispatcher that gates money/data-writing jobs).

const { runGroup } = require('./_lib/cron-multiplex.js');

const HANDLERS = [
  { name: 'cron-video-approval', mod: require('./cron-video-approval.js') },
  { name: 'cron-cron-fire-verifier', mod: require('./cron-cron-fire-verifier.js') },
  { name: 'cron-dossie-full-diagnostic', mod: require('./cron-dossie-full-diagnostic.js') },
  { name: 'cron-self-improvement-daily', mod: require('./cron-self-improvement-daily.js') },
  { name: 'cron-trending-audio-scan', mod: require('./cron-trending-audio-scan.js') },
];

module.exports = async function handler(req, res) {
  const results = await runGroup(req, HANDLERS);
  const anyFail = results.some((r) => r.status >= 400);
  return res.status(anyFail ? 207 : 200).json({
    ok: !anyFail,
    dispatcher: 'cron-dispatch-daily-1000',
    schedule: '0 10 * * *',
    dispatched: HANDLERS.length,
    results,
  });
};

module.exports.config = { maxDuration: 300 };
