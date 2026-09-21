'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeFundsDeliveryCollision } = require('./option-timing-risk');

// The two acceptance cases named explicitly: a Friday deal must warn, a
// Tuesday deal (normal week, no holiday nearby) must stay quiet.

test('Friday effective date (no holiday) — triggers, names Saturday and Sunday, 1 business day left', () => {
  // 2026-10-16 is a real Friday (verified via business-calendar.js dayOfWeekYMD).
  const result = computeFundsDeliveryCollision('2026-10-16', '2026-10-01');
  assert.ok(result, 'expected a collision to be detected');
  assert.equal(result.triggered, true);
  assert.equal(result.effectiveDayName, 'Friday');
  assert.equal(result.collidingDates.length, 2);
  assert.equal(result.collidingDates[0].reason, 'Saturday');
  assert.equal(result.collidingDates[1].reason, 'Sunday');
  assert.equal(result.businessDaysInWindow, 1);
  assert.match(result.body, /Saturday/);
  assert.match(result.body, /Sunday/);
  assert.match(result.body, /1 business day/);
});

test('Tuesday effective date, normal week, no holiday nearby — stays quiet (null)', () => {
  // 2026-10-20 is a real Tuesday; window is Wed/Thu/Fri, all business days,
  // no Texas Legal Holiday in range.
  const result = computeFundsDeliveryCollision('2026-10-20', '2026-10-01');
  assert.equal(result, null);
});

test('Monday effective date, normal week — also stays quiet (window is Tue/Wed/Thu)', () => {
  const result = computeFundsDeliveryCollision('2026-10-19', '2026-10-01');
  assert.equal(result, null);
});

// The case the coordinator named as the reason a fixed weekday list isn't
// enough: a normally-safe weekday whose window happens to include a Texas
// Legal Holiday.

test('Tuesday whose window includes a Wednesday federal holiday (Veterans Day) — triggers even though Tuesday is normally safe', () => {
  // 2026-11-10 is a Tuesday; window is Wed 11-11 (Veterans Day) / Thu 11-12 / Fri 11-13.
  const result = computeFundsDeliveryCollision('2026-11-10', '2026-11-01');
  assert.ok(result, 'a holiday inside an otherwise-safe window must still trigger');
  assert.equal(result.effectiveDayName, 'Tuesday');
  assert.equal(result.collidingDates.length, 1);
  assert.equal(result.collidingDates[0].date, '2026-11-11');
  assert.equal(result.collidingDates[0].reason, 'a Texas Legal Holiday');
  assert.equal(result.businessDaysInWindow, 2);
});

test('Tuesday whose window includes Juneteenth — same holiday-collision case, different holiday', () => {
  // 2026-06-16 is a Tuesday; window is Wed 6-17 / Thu 6-18 / Fri 6-19 (Juneteenth).
  const result = computeFundsDeliveryCollision('2026-06-16', '2026-06-01');
  assert.ok(result);
  assert.equal(result.collidingDates[0].date, '2026-06-19');
});

test('Monday whose window includes a Thursday holiday (Thanksgiving) — triggers', () => {
  // 2026-11-23 is a Monday; window is Tue 11-24 / Wed 11-25 / Thu 11-26 (Thanksgiving).
  const result = computeFundsDeliveryCollision('2026-11-23', '2026-11-01');
  assert.ok(result);
  assert.equal(result.collidingDates[0].date, '2026-11-26');
});

// Sunday execution is the REMEDY the coordinator names — confirm the same
// logic that flags Friday agrees Sunday is clean, so the advice Dossie gives
// is validated by the same computation, not a separately-asserted claim.

test('Sunday effective date — the suggested remedy — is itself clean (window is Mon/Tue/Wed)', () => {
  // 2026-10-18 is a Sunday.
  const result = computeFundsDeliveryCollision('2026-10-18', '2026-10-01');
  assert.equal(result, null);
});

// Remedy framing: "ask for Sunday execution" before the date happens vs.
// "propose an extension amendment at execution" once it's already locked in.

test('remedy framing: effective date still in the future — advises Sunday execution, not an amendment', () => {
  const result = computeFundsDeliveryCollision('2026-10-16', '2026-10-01');
  assert.equal(result.isAlreadyPast, false);
  assert.match(result.body, /asking the other agent to execute on Sunday/);
  assert.doesNotMatch(result.body, /extension amendment/);
});

test('remedy framing: effective date already passed — advises an extension amendment, not moving the date', () => {
  const result = computeFundsDeliveryCollision('2026-10-16', '2026-10-20');
  assert.equal(result.isAlreadyPast, true);
  assert.match(result.body, /extension amendment/);
  assert.doesNotMatch(result.body, /execute on Sunday/);
});

// Regression: the live-verified card originally read "Friday, Friday,
// October 16" and "Saturday, October 17 (Saturday)" — formatDateLong()
// already spells out the weekday, so repeating it (either as a leading
// "Friday, " prefix or a trailing "(Saturday)") reads as a copy bug.
test('body text does not repeat the weekday name for a plain Saturday/Sunday collision', () => {
  const result = computeFundsDeliveryCollision('2026-10-16', '2026-10-01');
  assert.doesNotMatch(result.body, /Friday, Friday/);
  assert.doesNotMatch(result.body, /Saturday, October 17 \(Saturday\)/);
  assert.match(result.body, /Saturday, October 17/);
});

test('the (reason) parenthetical IS kept when the collision is a holiday, not a weekend — that context is real information', () => {
  const result = computeFundsDeliveryCollision('2026-11-10', '2026-11-01');
  assert.match(result.body, /Wednesday, November 11 \(a Texas Legal Holiday\)/);
});

test('no effective date — returns null, never fabricates a date', () => {
  assert.equal(computeFundsDeliveryCollision(null, '2026-10-01'), null);
  assert.equal(computeFundsDeliveryCollision('', '2026-10-01'), null);
});

test('funds due date and option expiration come from chat-deal-deadlines.js, not re-derived here', () => {
  // Friday 2026-10-16 + 3 calendar days = Monday 2026-10-19, which is itself
  // a weekday so no further roll is needed — confirms the due date is the
  // real computed value, not a placeholder.
  const result = computeFundsDeliveryCollision('2026-10-16', '2026-10-01', { optionDays: 10 });
  assert.equal(result.fundsDueDate, '2026-10-19');
  assert.equal(result.fundsDueDateRolled, false);
  assert.equal(result.optionExpirationDate, '2026-10-26'); // fixed calendar count, does NOT roll
});
