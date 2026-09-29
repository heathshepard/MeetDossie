'use strict';

// api/cron-dispatch-every10.js
//
// AUTO-CONSOLIDATED DISPATCHER (Atlas, 2026-09-16, staging cron-count fix).
// Fan-out entry point for every job that was previously registered in
// vercel.json with its OWN cron entry at schedule "*/10 * * * *". Merged
// because 101 standalone entries exceeded Vercel's 100-item vercel.json
// crons-array schema cap. See api/_lib/cron-multiplex.js for exactly how
// auth, cadence, and failure-isolation are preserved per sub-job.
//
// Members (unchanged handlers, unchanged individual auth checks):
//   - /api/cron-auto-approve
//   - /api/cron-assemble-skits
//   - /api/cron-tc-reply-approval
//
// cron-tc-reply-approval ADDED 2026-09-17 (Carter) — moved from
// cron-dispatch-every30 to hit Heath's 1-hour TC-discovery reply SLA.
// End-to-end worst case with this change: harvest (<=15min, hot window) +
// draft/notify (<=10min, this dispatcher) + veto window (10min fixed) +
// poster's next 15-min local tick = 50min typical worst case, comfortably
// under 60 UNLESS the poster's 30-min facebook_reply min-gap is already
// occupied by an earlier reply — that case can genuinely exceed 60min (by
// design: the anti-ban min-gap is never relaxed to hit a timing target) and
// is exactly what api/_lib/silence-alarm.js's SLA-breach check
// (cron-auto-reply-veto-check.js sweepSlaAlerts, measured from
// harvested_at) exists to catch and surface, not silently absorb.
//
// DO NOT rename member files without updating the require() list below —
// there is no dynamic file-glob here on purpose (explicit > magic for a
// dispatcher that gates money/data-writing jobs).

const { runGroup, isAuthorizedDispatch } = require('./_lib/cron-multiplex.js');

const HANDLERS = [
  { name: 'cron-auto-approve', mod: require('./cron-auto-approve.js') },
  { name: 'cron-assemble-skits', mod: require('./cron-assemble-skits.js') },
  { name: 'cron-tc-reply-approval', mod: require('./cron-tc-reply-approval.js') },
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
    dispatcher: 'cron-dispatch-every10',
    schedule: '*/10 * * * *',
    dispatched: HANDLERS.length,
    results,
  });
};

// Bumped 20 -> 60 (Carter, 2026-09-17): cron-tc-reply-approval drafts up to
// MAX_PER_RUN rows with a real Claude API call (+ a risk-classifier call)
// per row; 20s was sized for the previous two lightweight members only.
// Must match the "functions" entry for this file in vercel.json.
module.exports.config = { maxDuration: 60 };
