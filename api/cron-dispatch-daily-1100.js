'use strict';

// api/cron-dispatch-daily-1100.js
//
// AUTO-CONSOLIDATED DISPATCHER (Atlas, 2026-09-16, staging cron-count fix).
// Fan-out entry point for every job that was previously registered in
// vercel.json with its OWN cron entry at schedule "0 11 * * *". Merged
// because 101 standalone entries exceeded Vercel's 100-item vercel.json
// crons-array schema cap. See api/_lib/cron-multiplex.js for exactly how
// auth, cadence, and failure-isolation are preserved per sub-job.
//
// Members (unchanged handlers, unchanged individual auth checks):
//   - /api/cron-pipeline-check
//   - /api/cron-generate-posts
//   - /api/cron-kpi-drift-detector
//   - /api/cron-autonomous-loop
//   - /api/cron-autonomous-daily-digest
//
// DO NOT rename member files without updating the require() list below —
// there is no dynamic file-glob here on purpose (explicit > magic for a
// dispatcher that gates money/data-writing jobs).

const { runGroup, isAuthorizedDispatch } = require('./_lib/cron-multiplex.js');

const HANDLERS = [
  { name: 'cron-pipeline-check', mod: require('./cron-pipeline-check.js') },
  { name: 'cron-generate-posts', mod: require('./cron-generate-posts.js') },
  { name: 'cron-kpi-drift-detector', mod: require('./cron-kpi-drift-detector.js') },
  { name: 'cron-autonomous-loop', mod: require('./cron-autonomous-loop.js') },
  { name: 'cron-autonomous-daily-digest', mod: require('./cron-autonomous-daily-digest.js') },
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
    dispatcher: 'cron-dispatch-daily-1100',
    schedule: '0 11 * * *',
    dispatched: HANDLERS.length,
    results,
  });
};

module.exports.config = { maxDuration: 300 };
