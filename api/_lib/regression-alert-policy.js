'use strict';

// api/_lib/regression-alert-policy.js
// =============================================================================
// WHEN THE DAILY REGRESSION SUITE IS ALLOWED TO PUSH A TELEGRAM ALERT
//
// WHY THIS EXISTS (2026-09-17, item B3)
//   The suite has been RED every single day since at least 2026-07-12:
//   `failed=6, passed=47`, identical failure set, day after day. The old
//   policy in cron-regression-suite.js was:
//
//       if (severity === 'RED') sendTelegram(...)   // unconditional, daily
//
//   Two things were wrong with that, and they compounded:
//
//   1. The send was ALSO gated off — 'cron-regression-suite' was missing from
//      ALWAYS_ALLOW in telegram-gate.js — so zero alerts actually reached
//      Heath. A real PASS→FAIL regression on cron.cron-deadline-reminders on
//      2026-09-10 was eaten silently.
//   2. Un-gating it alone would have made it WORSE, not better: Heath would
//      have started receiving the same 6-failure message every morning
//      forever. A daily alert that never changes is trained-out within a
//      week, which reproduces the exact blindness with extra steps. It also
//      would have broken telegram-gate's ALWAYS_ALLOW contract, which is
//      explicitly for "exception-only alerts (they send nothing on a healthy
//      system) rather than scheduled digests".
//
//   So the gate entry and this policy are one fix, not two. Allow-listing the
//   job is only correct BECAUSE the job now behaves like an exception-only
//   alert: it speaks when the failure set CHANGES, and otherwise stays quiet
//   apart from a low-frequency still-broken reminder.
//
// THE RULE
//   Speak when the news is new:
//     - the failure set changed (a PASS→FAIL regression, a FAIL→PASS
//       recovery, or a brand-new test that is already failing)  -> alert
//     - everything just went green after being red                -> alert
//     - nothing changed and we are still failing                  -> stay
//       quiet, EXCEPT one "still broken" reminder every
//       REMINDER_HOURS (default 168h / weekly), so a permanently-red
//       suite can never fade into the background entirely
//     - nothing changed and everything is green                   -> silent
//
//   "Never alerted before" counts as due for a reminder. That makes the very
//   first run after this ships announce the standing failure set once.
//
// TESTABILITY
//   Everything here is pure: no fetch, no Supabase, no Date.now() reads that
//   aren't passed in. api/_lib/regression-alert-policy.test.js exercises it
//   directly (`node --test`), because reasoning about an alert path is how it
//   stayed broken for two months in the first place.
//
// Owner: 2026-09-17.

// How long a persistently-failing suite may stay quiet before it nags once.
// Weekly by default: frequent enough that a two-month-old red suite cannot be
// invisible, rare enough that it never becomes wallpaper.
const DEFAULT_REMINDER_HOURS = 168;

function reminderHours() {
  const raw = Number(process.env.REGRESSION_REMINDER_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REMINDER_HOURS;
}

function summarize(results) {
  const list = Array.isArray(results) ? results : [];
  const passed = list.filter((r) => r && r.verdict === 'PASS').length;
  const failed = list.filter((r) => r && r.verdict === 'FAIL').length;
  const skipped = list.filter((r) => r && r.verdict === 'SKIP').length;
  return { total: list.length, passed, failed, skipped };
}

// PASS→FAIL / FAIL→PASS / newly-appeared-and-failing, against the previous run.
function computeDeltas(current, previous) {
  const cur = Array.isArray(current) ? current : [];
  if (!Array.isArray(previous) || previous.length === 0) {
    return { regressions: [], recoveries: [], newTests: [], firstRun: true };
  }
  const prev = new Map(previous.map((r) => [r.id, r.verdict]));
  const regressions = [];
  const recoveries = [];
  const newTests = [];
  for (const c of cur) {
    const p = prev.get(c.id);
    if (p === undefined) {
      if (c.verdict === 'FAIL') newTests.push(c);
      continue;
    }
    if (p === 'PASS' && c.verdict === 'FAIL') regressions.push({ ...c, previous_verdict: p });
    if (p === 'FAIL' && c.verdict === 'PASS') recoveries.push({ ...c, previous_verdict: p });
  }
  return { regressions, recoveries, newTests, firstRun: false };
}

function severityOf(sum) {
  if (!sum || !sum.total) return 'GREEN';
  if (sum.failed === 0) return 'GREEN';
  const pct = (sum.failed / sum.total) * 100;
  return pct <= 10 ? 'YELLOW' : 'RED';
}

/**
 * Decide whether this run earns a Telegram push.
 *
 * Pure. Every input is explicit so the whole decision table can be unit-tested.
 *
 * @param {object} args
 * @param {{total:number,passed:number,failed:number,skipped:number}} args.sum  this run
 * @param {{regressions:Array,recoveries:Array,newTests:Array,firstRun:boolean}} args.deltas
 * @param {boolean} args.prevWasGreen     previous recorded run had 0 failures
 * @param {boolean} args.hadPrevious      a previous run exists at all
 * @param {number|null} args.hoursSinceLastAlert  age of the last run that actually
 *        delivered an alert; null = never alerted (or unknown), which counts as due
 * @param {number} [args.reminderAfterHours]
 * @returns {{ alert:boolean, kind:string, reason:string, severity:string, isReminder:boolean }}
 */
function decideAlert(args) {
  const {
    sum,
    deltas,
    prevWasGreen = false,
    hadPrevious = true,
    hoursSinceLastAlert = null,
    reminderAfterHours = reminderHours(),
  } = args || {};

  const severity = severityOf(sum);
  const d = deltas || { regressions: [], recoveries: [], newTests: [], firstRun: !hadPrevious };
  const changed =
    (d.regressions || []).length + (d.recoveries || []).length + (d.newTests || []).length > 0;

  const no = (kind, reason) => ({ alert: false, kind, reason, severity, isReminder: false });
  const yes = (kind, reason, isReminder = false) => ({ alert: true, kind, reason, severity, isReminder });

  // Healthy.
  if (severity === 'GREEN') {
    // Just came back from red — that's news, and it closes the loop on
    // whatever alert reported the breakage.
    if (!hadPrevious) return no('green_first_run', 'first recorded run is green — nothing to report');
    if (!prevWasGreen || (d.recoveries || []).length > 0) {
      return yes('all_clear', 'suite recovered to GREEN');
    }
    return no('green_steady', 'green and unchanged');
  }

  // Failing. No previous run to compare against: say so once.
  if (!hadPrevious || d.firstRun) {
    return yes('first_run_failing', `first recorded run is ${severity}`);
  }

  // The news is the CHANGE, not the redness.
  if (changed) {
    const bits = [];
    if ((d.regressions || []).length) bits.push(`${d.regressions.length} regression(s)`);
    if ((d.newTests || []).length) bits.push(`${d.newTests.length} new failing`);
    if ((d.recoveries || []).length) bits.push(`${d.recoveries.length} recovered`);
    return yes('failure_set_changed', `failure set changed: ${bits.join(', ')}`);
  }

  // Unchanged and still failing. Quiet, with a periodic reminder so a
  // permanently-red suite can never become invisible.
  if (hoursSinceLastAlert === null || !Number.isFinite(hoursSinceLastAlert)) {
    return yes('still_failing_reminder', 'no prior delivered alert on record', true);
  }
  if (hoursSinceLastAlert >= reminderAfterHours) {
    return yes(
      'still_failing_reminder',
      `unchanged for ${Math.floor(hoursSinceLastAlert / 24)}d since the last delivered alert`,
      true
    );
  }
  return no(
    'unchanged_suppressed',
    `same ${sum.failed} failures as the last run; next reminder in ` +
      `${Math.max(0, Math.round(reminderAfterHours - hoursSinceLastAlert))}h`
  );
}

module.exports = {
  DEFAULT_REMINDER_HOURS,
  reminderHours,
  summarize,
  computeDeltas,
  severityOf,
  decideAlert,
};
