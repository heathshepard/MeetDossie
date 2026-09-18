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
//   - /api/cron-silence-alarm (added 2026-09-18 — see note below)
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
// ADDED 2026-09-18 (Carter, Quinn QA round 2 on staging 816ccd57) —
// cron-silence-alarm: the consolidation above said the folded heartbeat
// replaces the two retired 7AM messages and "arrives at 7AM." It didn't —
// cron-silence-alarm kept ITS OWN standalone vercel.json entry at
// "20 15 * * *" (10:20am CDT), the schedule it already had before the
// consolidation, while cron-morning-brief and cron-social-digest (the two
// jobs it replaced) both ran at "0 12 * * *" (7am CDT) — this dispatcher's
// exact slot. Moved here instead of just editing cron-silence-alarm.js's own
// vercel.json schedule string so this stays a dispatcher-slot move, not a
// new standalone crons[] entry (54/100 in use). Its own cron_runs telemetry
// keeps firing under its own job name (see api/_lib/cron-telemetry.js /
// telegramGate.runWithJobContext in cron-multiplex.js's runGroup) exactly as
// it would standalone. ALARM half is dedup'd via alert_state with
// ALERT_COOLDOWN_HOURS=20 (see api/_lib/silence-alarm.js) — specifically
// chosen to survive a one-time schedule-time shift like this one without
// skipping a day: old last-fire 10:20am -> new first-fire next day 7:00am is
// a 20h40m gap, still just over the 20h cooldown, so the very next run still
// fires normally. The HEARTBEAT half is never dedup'd (sends every run
// regardless), so it isn't affected by the schedule move at all. What the
// alarm checks and how it dedups are both unchanged by this move — only the
// clock time changed. This function's own maxDuration/includeFiles were
// bumped in vercel.json to match what cron-silence-alarm.js's own standalone
// entry already required (cron-sanity.js reads vercel.json + api/**/*.js at
// runtime).
//
// DO NOT rename member files without updating the require() list below —
// there is no dynamic file-glob here on purpose (explicit > magic for a
// dispatcher that gates money/data-writing jobs).

const { runGroup, isAuthorizedDispatch } = require('./_lib/cron-multiplex.js');

const HANDLERS = [
  { name: 'cron-followup', mod: require('./cron-followup.js') },
  { name: 'cron-customer-morning-brief', mod: require('./cron-customer-morning-brief.js') },
  { name: 'cron-silence-alarm', mod: require('./cron-silence-alarm.js') },
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

// Bumped 20 -> 30 (Carter, 2026-09-18) when cron-silence-alarm joined this
// group — matches the maxDuration its own standalone vercel.json entry
// already declared (includeFiles bumped the same way; see vercel.json's
// "api/cron-dispatch-daily-1200.js" functions entry).
module.exports.config = { maxDuration: 30 };
