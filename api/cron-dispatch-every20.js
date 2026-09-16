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
//
// DO NOT rename member files without updating the require() list below —
// there is no dynamic file-glob here on purpose (explicit > magic for a
// dispatcher that gates money/data-writing jobs).

const { runGroup, isAuthorizedDispatch } = require('./_lib/cron-multiplex.js');

const HANDLERS = [
  { name: 'cron-dossie-sign-completion-loop', mod: require('./cron-dossie-sign-completion-loop.js') },
  { name: 'cron-content-pipeline-review', mod: require('./cron-content-pipeline-review.js') },
  { name: 'cron-engagement-review', mod: require('./cron-engagement-review.js') },
  { name: 'cron-content-pipeline-promote', mod: require('./cron-content-pipeline-promote.js') },
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
    dispatcher: 'cron-dispatch-every20',
    schedule: '*/20 * * * *',
    dispatched: HANDLERS.length,
    results,
  });
};

module.exports.config = { maxDuration: 300 };
