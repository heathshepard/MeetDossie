'use strict';

// api/cron-dispatch-daily-1330.js
//
// AUTO-CONSOLIDATED DISPATCHER (Atlas, 2026-09-16, staging cron-count fix).
// Fan-out entry point for every job that was previously registered in
// vercel.json with its OWN cron entry at schedule "30 13 * * *". Merged
// because 101 standalone entries exceeded Vercel's 100-item vercel.json
// crons-array schema cap. See api/_lib/cron-multiplex.js for exactly how
// auth, cadence, and failure-isolation are preserved per sub-job.
//
// Members (unchanged handlers, unchanged individual auth checks):
//   - /api/cron-post-videos
//   - /api/cron-deletion-reminders
//   - /api/cron-deal-watch   (added 2026-09-20; reuses this dispatcher rather
//     than adding a vercel.json entry, per the current convention. 08:30 CT is
//     deliberate: after cron-deadline-reminders at 13:05 UTC so the two never
//     race, and after cron-email-to-dossier has had all night at 15-minute
//     intervals to file overnight mail onto the dossiers this job reads.)
//
// DO NOT rename member files without updating the require() list below —
// there is no dynamic file-glob here on purpose (explicit > magic for a
// dispatcher that gates money/data-writing jobs).

const { runGroup, isAuthorizedDispatch } = require('./_lib/cron-multiplex.js');

const HANDLERS = [
  { name: 'cron-post-videos', mod: require('./cron-post-videos.js') },
  { name: 'cron-deletion-reminders', mod: require('./cron-deletion-reminders.js') },
  { name: 'cron-deal-watch', mod: require('./cron-deal-watch.js') },
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
    dispatcher: 'cron-dispatch-daily-1330',
    schedule: '30 13 * * *',
    dispatched: HANDLERS.length,
    results,
  });
};

module.exports.config = { maxDuration: 20 };
