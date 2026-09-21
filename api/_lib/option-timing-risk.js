// api/_lib/option-timing-risk.js
// ============================================================================
// Pure detection logic for the "Friday execution = option fee trap" pattern.
// Heath's words: "Regarding the option fee Dossie needs to also suggest to
// subscribers that if it's on a Friday and we're submitting a contract to
// maybe also ask the other agent to execute the contract on Sunday so that
// our option can start on Monday. I want Dossie to be proactive and able to
// help subscribers from getting into difficult situations like we got into
// with Low Oak." Cost him $5,200 — see low-oak-earnest-money-dispute memory.
//
// THE MECHANIC (TREC ¶5A(2)): option fee and earnest money are due within 3
// CALENDAR days of the effective date, and that delivery deadline rolls to
// the next business day if it lands on a Saturday, Sunday, or Texas Legal
// Holiday. The option period itself is a FIXED calendar count and does NOT
// roll (see business-calendar.js's ROLLOVER_APPLIES). A Friday effective
// date puts the 3-day count on Sat/Sun/Mon — a title company closed two of
// those three days — leaving effectively one business day to deliver funds,
// while the option clock is already burning on non-business days nobody can
// act on. Execute Sunday instead and the same 3-day count falls Mon/Tue/Wed
// — three real business days — with the option period starting fresh Monday.
//
// THE TRIGGER RULE: not a fixed Wed/Thu/Fri weekday list — that's the
// SHAPE the rule takes in a normal (holiday-free) week, but the real
// condition is general: does AT LEAST ONE of the 3 calendar days after the
// effective date (the delivery-window days) land on a weekend or Texas
// Legal Holiday? Verified this reconstructs Wed/Thu/Fri exactly under a
// normal week (Wed+3=Sat, Thu+3=Sun via Sat/Sun, Fri+3=Sat/Sun/Mon) while
// ALSO catching the holiday-adjacent case the coordinator named as the
// reason a fixed weekday list isn't enough: "a Thursday execution before a
// Friday holiday has the same problem" — and generalizes further, e.g. a
// normally-safe Tuesday whose window happens to include a Wednesday
// holiday. Monday and Tuesday stay silent in a normal week (their 3-day
// windows are entirely weekdays), matching the two acceptance cases this
// was verified against: a Friday deal warns, a Tuesday deal stays quiet.
//
// This module is PURE — no I/O, no Supabase, no dossie_asks writes. It
// reuses api/_lib/chat-deal-deadlines.js's deriveDealDeadlines() for the
// funds-due-date and option-expiration math (the exact module already
// verified live against the deadline-rollover regression) rather than
// re-deriving TREC date arithmetic a second time — that asymmetry (funds
// roll, option period doesn't) is exactly what's easy to get backwards.
//
// Owner: Carter, 2026-09-21 (Heath-requested capability, Low Oak follow-up).
// ============================================================================

'use strict';

const { addCalendarDaysYMD, isWeekendOrTexasLegalHoliday, isTexasLegalHoliday, dayOfWeekYMD, normalizeYMD } = require('./business-calendar');
const { deriveDealDeadlines } = require('./chat-deal-deadlines');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatDateLong(ymd) {
  if (!ymd) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  // UTC-anchored, same convention as the rest of business-calendar.js.
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
}

function reasonForDate(ymd) {
  const dow = dayOfWeekYMD(ymd);
  if (dow === 0) return 'Sunday';
  if (dow === 6) return 'Saturday';
  if (isTexasLegalHoliday(ymd)) return 'a Texas Legal Holiday';
  return null;
}

/**
 * @param {string|Date} effectiveDateInput - the contract's effective date
 *   (already executed) or a proposed/candidate effective date being
 *   considered before sending.
 * @param {string|Date} todayInput - "today," for deciding whether the
 *   remedy should be "ask for Sunday execution" (date hasn't happened yet)
 *   or "propose an extension amendment at execution" (already locked in).
 * @param {{optionDays?: number, optionExpirationDate?: string}} [dealFields]
 *   - passed straight through to deriveDealDeadlines() so a stored option
 *   expiration date (if already on file) wins over a derived one, exactly
 *   matching that module's own precedence rule.
 * @returns {object|null} null if there's no effective date to evaluate or
 *   the window doesn't collide with a weekend/holiday. Otherwise the full
 *   detection result, including the dossie_asks title/body text.
 */
function computeFundsDeliveryCollision(effectiveDateInput, todayInput, dealFields = {}) {
  const effective = normalizeYMD(effectiveDateInput);
  if (!effective) return null;
  const today = normalizeYMD(todayInput) || effective;

  const deadlines = deriveDealDeadlines({
    contractEffectiveDate: effective,
    optionExpirationDate: dealFields.optionExpirationDate || null,
    optionDays: dealFields.optionDays || null,
  });

  // The 3 calendar days that make up the ¶5A(2) delivery window: effective+1
  // through effective+3 (the raw, pre-rollover count).
  const windowDates = [1, 2, 3].map((n) => addCalendarDaysYMD(effective, n));
  const collidingDates = windowDates
    .map((d) => ({ date: d, reason: reasonForDate(d) }))
    .filter((d) => d.reason);

  if (collidingDates.length === 0) return null; // Mon/Tue in a holiday-free week — no collision, stay quiet.

  const businessDaysInWindow = windowDates.length - collidingDates.length;
  const isAlreadyPast = effective <= today;
  const effectiveDayName = DAY_NAMES[dayOfWeekYMD(effective)];

  // formatDateLong() already spells out the weekday (e.g. "Saturday, October
  // 17"), so appending "(Saturday)" would just repeat it — the parenthetical
  // is only useful when the reason ISN'T the weekday name, i.e. a holiday.
  const collisionPhrase = collidingDates
    .map((d) => (d.reason === 'Saturday' || d.reason === 'Sunday' ? formatDateLong(d.date) : `${formatDateLong(d.date)} (${d.reason})`))
    .join(' and ');

  const remedy = isAlreadyPast
    ? `The effective date is already set and the option period is already running, so moving the date isn't the fix now — ` +
      `the fallback is an option-period extension amendment, proposed at execution rather than after the funds-delivery ` +
      `deadline has already passed. That buys back the business days the weekend/holiday took out of the option period.`
    : `Since this hasn't gone out yet, the clean fix is asking the other agent to execute on Sunday instead — the same ` +
      `3-day funds-delivery window then falls entirely on business days, and the option period starts fresh Monday morning ` +
      `instead of losing its first days to a weekend nobody can act on.`;

  const body =
    `${formatDateLong(effective)} as the effective date puts the ¶5.A funds-delivery window on ` +
    `${collisionPhrase} — the title company is closed those days, so there${collidingDates.length > 1 ? "'re" : "'s"} only ` +
    `${businessDaysInWindow} business day${businessDaysInWindow === 1 ? '' : 's'} to actually deliver the option fee and ` +
    `earnest money before the ${formatDateLong(deadlines.optionFeeDueDate)} deadline, while the option period keeps ` +
    `running on the calendar regardless. ${remedy}`;

  return {
    triggered: true,
    effectiveDate: effective,
    effectiveDayName,
    windowDates,
    collidingDates,
    businessDaysInWindow,
    fundsDueDateRaw: deadlines.fundsDeliveryDueDateRaw,
    fundsDueDate: deadlines.optionFeeDueDate,
    fundsDueDateRolled: deadlines.fundsDeliveryRolled,
    optionExpirationDate: deadlines.optionExpirationDate,
    isAlreadyPast,
    title: isAlreadyPast ? 'Option period is already losing business days to a weekend' : 'This effective date walks into the Friday option-fee trap',
    body,
  };
}

module.exports = {
  computeFundsDeliveryCollision,
};
