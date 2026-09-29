'use strict';

// api/_lib/regression-alert-policy.test.js
//
// The decision table for "does this regression run earn a Telegram push?"
// Written 2026-09-17 with the B3 fix. The old policy was four inline `if`
// branches in the cron handler that nobody could run, which is a large part
// of why it stayed wrong for two months.
//
// Run: node --test api/_lib/regression-alert-policy.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  summarize,
  computeDeltas,
  severityOf,
  decideAlert,
  DEFAULT_REMINDER_HOURS,
} = require('./regression-alert-policy');

// --- fixtures ---------------------------------------------------------------

const pass = (id) => ({ id, verdict: 'PASS' });
const fail = (id, error) => ({ id, verdict: 'FAIL', error: error || 'boom' });

// The real standing failure set: 47 passed / 6 failed, every day since July.
function standingRun(overrides = {}) {
  const results = [];
  for (let i = 0; i < 47; i++) results.push(pass(`t.pass.${i}`));
  const failing = [
    'api.health.create_checkout_session',
    'cron.cron-alert-health',
    'cron.cron-platform-health-checker',
    'db.freshness.audit_logs',
    'db.email.morning_brief_recent',
    'db.testimonial.no_stale_drafts',
  ];
  for (const id of failing) results.push(fail(id));
  return Object.assign({ results }, overrides);
}

function decide(current, previous, opts = {}) {
  const sum = summarize(current);
  const deltas = computeDeltas(current, previous);
  const prevSum = summarize(previous);
  return decideAlert({
    sum,
    deltas,
    prevWasGreen: previous.length > 0 && prevSum.failed === 0,
    hadPrevious: previous.length > 0,
    hoursSinceLastAlert: 'hoursSinceLastAlert' in opts ? opts.hoursSinceLastAlert : 1,
    reminderAfterHours: opts.reminderAfterHours,
  });
}

// --- severity ---------------------------------------------------------------

test('severityOf: 6/53 failing is RED, which is why the old rule fired daily', () => {
  assert.equal(severityOf({ total: 53, passed: 47, failed: 6 }), 'RED');
  assert.equal(severityOf({ total: 53, passed: 53, failed: 0 }), 'GREEN');
  assert.equal(severityOf({ total: 53, passed: 50, failed: 3 }), 'YELLOW'); // 5.6%
});

// --- the core B3 behaviour change ------------------------------------------

test('THE FIX: an unchanged RED run is silent, not a daily 🚨', () => {
  const today = standingRun().results;
  const yesterday = standingRun().results;
  const d = decide(today, yesterday, { hoursSinceLastAlert: 24 });
  assert.equal(d.severity, 'RED', 'still genuinely red — we are not pretending otherwise');
  assert.equal(d.alert, false);
  assert.equal(d.kind, 'unchanged_suppressed');
});

test('THE FIX: a real PASS→FAIL regression inside an already-RED suite DOES alert', () => {
  // This is the 2026-09-10 case: cron.cron-deadline-reminders went PASS→FAIL
  // (6 failures became 7) and produced no alert at all.
  const yesterday = standingRun().results;
  const today = standingRun().results.map((r) =>
    r.id === 't.pass.0' ? fail('t.pass.0', 'stale: 40h ago') : r
  );
  const d = decide(today, yesterday, { hoursSinceLastAlert: 1 });
  assert.equal(d.alert, true);
  assert.equal(d.kind, 'failure_set_changed');
  assert.match(d.reason, /1 regression/);
});

test('a FAIL→PASS recovery inside a still-RED suite alerts too', () => {
  const yesterday = standingRun().results;
  const today = standingRun().results.map((r) =>
    r.id === 'db.freshness.audit_logs' ? pass('db.freshness.audit_logs') : r
  );
  const d = decide(today, yesterday, { hoursSinceLastAlert: 1 });
  assert.equal(d.alert, true);
  assert.equal(d.kind, 'failure_set_changed');
  assert.match(d.reason, /1 recovered/);
});

test('a brand-new test that is already failing alerts', () => {
  const yesterday = standingRun().results;
  const today = standingRun().results.concat([fail('db.orphans.documents_transaction', '33 orphans')]);
  const d = decide(today, yesterday, { hoursSinceLastAlert: 1 });
  assert.equal(d.alert, true);
  assert.equal(d.kind, 'failure_set_changed');
  assert.match(d.reason, /1 new failing/);
});

test('a test that flips FAIL→PASS→FAIL alerts on each flip (flapping is real signal)', () => {
  const red = standingRun().results;
  const green = standingRun().results.map((r) =>
    r.id === 'db.freshness.audit_logs' ? pass('db.freshness.audit_logs') : r
  );
  assert.equal(decide(green, red, { hoursSinceLastAlert: 1 }).alert, true);
  assert.equal(decide(red, green, { hoursSinceLastAlert: 1 }).alert, true);
});

// --- the anti-fade reminder -------------------------------------------------

test('an unchanged RED run nags exactly once per reminder window', () => {
  const today = standingRun().results;
  const yesterday = standingRun().results;

  const justBefore = decide(today, yesterday, {
    hoursSinceLastAlert: DEFAULT_REMINDER_HOURS - 1,
    reminderAfterHours: DEFAULT_REMINDER_HOURS,
  });
  assert.equal(justBefore.alert, false, 'inside the window: quiet');

  const due = decide(today, yesterday, {
    hoursSinceLastAlert: DEFAULT_REMINDER_HOURS,
    reminderAfterHours: DEFAULT_REMINDER_HOURS,
  });
  assert.equal(due.alert, true, 'window elapsed: nag once');
  assert.equal(due.kind, 'still_failing_reminder');
  assert.equal(due.isReminder, true);
});

test('no prior DELIVERED alert on record counts as due — the first post-deploy run speaks', () => {
  // On rollout, no regression_runs row has a truthful alert_sent=true, so
  // hoursSinceLastAlert is null. The standing 6 failures get announced once.
  const d = decide(standingRun().results, standingRun().results, { hoursSinceLastAlert: null });
  assert.equal(d.alert, true);
  assert.equal(d.kind, 'still_failing_reminder');
  assert.equal(d.isReminder, true);
});

test('the reminder window is a week by default, not a day', () => {
  assert.equal(DEFAULT_REMINDER_HOURS, 168);
});

// --- green paths ------------------------------------------------------------

test('RED → GREEN sends an all-clear', () => {
  const yesterday = standingRun().results;
  const today = yesterday.map((r) => pass(r.id));
  const d = decide(today, yesterday, { hoursSinceLastAlert: 1 });
  assert.equal(d.alert, true);
  assert.equal(d.kind, 'all_clear');
  assert.equal(d.severity, 'GREEN');
});

test('GREEN → GREEN is silent', () => {
  const results = standingRun().results.map((r) => pass(r.id));
  const d = decide(results, results, { hoursSinceLastAlert: 1 });
  assert.equal(d.alert, false);
  assert.equal(d.kind, 'green_steady');
});

// --- edges ------------------------------------------------------------------

test('the very first recorded run reports if it is failing, and stays quiet if green', () => {
  const failing = decide(standingRun().results, []);
  assert.equal(failing.alert, true);
  assert.equal(failing.kind, 'first_run_failing');

  const green = decide(standingRun().results.map((r) => pass(r.id)), []);
  assert.equal(green.alert, false);
  assert.equal(green.kind, 'green_first_run');
});

test('YELLOW follows the same delta rule as RED — no special case', () => {
  const prev = [pass('a'), pass('b'), fail('c')];
  const same = [pass('a'), pass('b'), fail('c')];
  const changed = [pass('a'), fail('b'), fail('c')];
  assert.equal(decide(same, prev, { hoursSinceLastAlert: 1 }).alert, false);
  assert.equal(decide(changed, prev, { hoursSinceLastAlert: 1 }).alert, true);
});

test('computeDeltas flags firstRun only when there is no previous run', () => {
  assert.equal(computeDeltas([pass('a')], []).firstRun, true);
  assert.equal(computeDeltas([pass('a')], [pass('a')]).firstRun, false);
});

test('summarize counts SKIP separately from PASS/FAIL', () => {
  const s = summarize([pass('a'), fail('b'), { id: 'c', verdict: 'SKIP' }]);
  assert.deepEqual(s, { total: 3, passed: 1, failed: 1, skipped: 1 });
});

// --- the real 12 days -------------------------------------------------------

test('replaying the real 9/06→9/17 history: 2 alerts instead of 12', () => {
  // Live regression_runs, source=vercel-cron: 47/6 every day except 9/10
  // (46/7, one PASS→FAIL) and 9/11 (back to 47/6, one FAIL→PASS).
  const normal = () => standingRun().results;
  const broken = () => standingRun().results.map((r) => (r.id === 't.pass.0' ? fail('t.pass.0') : r));

  const days = [
    normal(), normal(), normal(), normal(), // 9/06 - 9/09
    broken(),                               // 9/10 regression
    normal(),                               // 9/11 recovery
    normal(), normal(), normal(), normal(), normal(), normal(), // 9/12 - 9/17
  ];

  let alerts = 0;
  let hoursSinceLastAlert = 1; // pretend a recent alert so the reminder is not due
  for (let i = 1; i < days.length; i++) {
    const d = decide(days[i], days[i - 1], {
      hoursSinceLastAlert,
      reminderAfterHours: DEFAULT_REMINDER_HOURS,
    });
    if (d.alert) {
      alerts += 1;
      hoursSinceLastAlert = 0;
    } else {
      hoursSinceLastAlert += 24;
    }
  }

  // The old rule: RED → send, every single one of these 11 days.
  // The new rule: exactly the two days where the news actually changed.
  assert.equal(alerts, 2, 'the regression and the recovery — nothing else');
});
