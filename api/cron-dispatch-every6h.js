'use strict';

// api/cron-dispatch-every6h.js
//
// AUTO-CONSOLIDATED DISPATCHER (Atlas, 2026-09-16, staging cron-count fix).
// Fan-out entry point for every job that was previously registered in
// vercel.json with its OWN cron entry at schedule "0 */6 * * *". Merged
// because 101 standalone entries exceeded Vercel's 100-item vercel.json
// crons-array schema cap. See api/_lib/cron-multiplex.js for exactly how
// auth, cadence, and failure-isolation are preserved per sub-job.
//
// Members (unchanged handlers, unchanged individual auth checks):
//   - /api/cron-account-session-monitor
//   - /api/cron-reconcile-future-builds
//   - /api/cron-codebase-facts-indexer
//   - /api/cron-outcome-monitor  (Atlas, 2026-09-25)
//
// cron-outcome-monitor joins here rather than taking a new vercel.json entry
// or a cron-job.org job: the cron array is already near its schema cap and
// "0 */6 * * *" is exactly the cadence it wants. Six-hourly is deliberate --
// the expectation windows are 24h and 7d, so checking more often would only
// re-ask a question whose answer cannot have changed.
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
const MAX_DURATION_S = 130;

const HANDLERS = [
  { name: 'cron-account-session-monitor', mod: require('./cron-account-session-monitor.js') },
  { name: 'cron-reconcile-future-builds', mod: require('./cron-reconcile-future-builds.js') },
  { name: 'cron-codebase-facts-indexer', mod: require('./cron-codebase-facts-indexer.js') },
  { name: 'cron-outcome-monitor', mod: require('./cron-outcome-monitor.js') },
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
    dispatcher: 'cron-dispatch-every6h',
    schedule: '0 */6 * * *',
    dispatched: HANDLERS.length,
    results,
  });
};

module.exports.config = { maxDuration: MAX_DURATION_S };
