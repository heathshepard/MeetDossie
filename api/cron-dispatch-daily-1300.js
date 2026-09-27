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
//   - /api/cron-pierce-activation   (added 2026-09-18)
//   - /api/cron-account-invite-autoresend   (added 2026-09-26)
//
// cron-pierce-activation was never registered ANYWHERE before 2026-09-18 — its
// own header claimed an external cron-job.org trigger that does not exist, so
// nothing ever invoked it. It is the job that flags paying customers who cannot
// or do not sign in, and its absence is why five of eight went unnoticed for
// four months (docs/ACTIVATION-FORENSICS-2026-09-18.md). Its documented
// schedule is "0 13 * * *", which is exactly this dispatcher's, so it joins the
// group rather than consuming another of vercel.json's 100 cron slots.
// It notifies Heath on Telegram only and never emails a customer.
//
// cron-account-invite-autoresend is the follow-through on that same forensics
// doc: it auto re-issues a durable 30-day invite (api/_lib/account-invites.js)
// to any paying customer who has never held a session, once they are past
// ACCOUNT_INVITE_AUTORESEND_HOURS (default 48h). Ships inert
// (ACCOUNT_INVITE_AUTORESEND_MODE default 'report' — counts candidates, emails
// nobody) until Heath flips the mode to 'send', same pattern as
// cron-activation-drip's ACTIVATION_DRIP_BACKFILL_MODE. Same cadence as
// cron-pierce-activation on purpose — it watches the same population.
//
// DO NOT rename member files without updating the require() list below —
// there is no dynamic file-glob here on purpose (explicit > magic for a
// dispatcher that gates money/data-writing jobs).

const { runGroup, isAuthorizedDispatch } = require('./_lib/cron-multiplex.js');

const HANDLERS = [
  { name: 'cron-calculator-deadline-reminders', mod: require('./cron-calculator-deadline-reminders.js') },
  { name: 'cron-email-digest', mod: require('./cron-email-digest.js') },
  { name: 'cron-pipeline-health', mod: require('./cron-pipeline-health.js') },
  { name: 'cron-render-skits', mod: require('./cron-render-skits.js') },
  { name: 'cron-morning-ops-digest', mod: require('./cron-morning-ops-digest.js') },
  { name: 'cron-pierce-activation', mod: require('./cron-pierce-activation.js') },
  { name: 'cron-account-invite-autoresend', mod: require('./cron-account-invite-autoresend.js') },
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
    dispatcher: 'cron-dispatch-daily-1300',
    schedule: '0 13 * * *',
    dispatched: HANDLERS.length,
    results,
  });
};

module.exports.config = { maxDuration: 40 };
