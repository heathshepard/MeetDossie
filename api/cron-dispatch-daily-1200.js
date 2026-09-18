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
//   - /api/cron-customer-morning-brief
//
// REMOVED 2026-09-18 (Carter, morning-message consolidation — see
// api/cron-silence-alarm.js header for the full writeup):
//   - cron-morning-brief — retired its own Telegram send; buildBrief() is
//     now required directly by api/cron-silence-alarm.js and folded into
//     that single daily message instead. Running it here too would just be
//     a wasted duplicate compute (it sends nothing on its own anymore).
//   - cron-social-digest — fully retired (deleted). It was ALSO one of the
//     three competing 7AM Telegram messages, and had been silently dead
//     since 2026-08-16 (telegram-gate kill switch shipped that day without
//     adding it to ALWAYS_ALLOW — every send since returned a fake 200 and
//     never reached Heath). Its one useful number (per-platform CREATED-
//     last-24h status counts) is folded into cron-silence-alarm.js's
//     heartbeat; its coarse alerts are superseded by that file's own
//     (unsuppressed) checks. Also removed from Sage's chat-trigger
//     allowlist in api/_lib/sage-triggers.js.
//
// DO NOT rename member files without updating the require() list below —
// there is no dynamic file-glob here on purpose (explicit > magic for a
// dispatcher that gates money/data-writing jobs).

const { runGroup, isAuthorizedDispatch } = require('./_lib/cron-multiplex.js');

const HANDLERS = [
  { name: 'cron-followup', mod: require('./cron-followup.js') },
  { name: 'cron-customer-morning-brief', mod: require('./cron-customer-morning-brief.js') },
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
    dispatcher: 'cron-dispatch-daily-1200',
    schedule: '0 12 * * *',
    dispatched: HANDLERS.length,
    results,
  });
};

module.exports.config = { maxDuration: 20 };
