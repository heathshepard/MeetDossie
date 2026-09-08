// api/_lib/business-calendar.js
//
// Contract-deadline date math for TREC transactions: Texas Legal Holiday
// table + the ¶5A(2) weekend/holiday rollover rule.
//
// Deliberately NOT part of api/_lib/scheduling.js — that module computes
// showing-slot occupancy (per-owner time-of-day windows), a different domain.
// This module is contract-legal date arithmetic and is called from the
// deadline-reminder cron, the transaction update endpoints, and (future)
// the compressed-window recommendation trigger.
//
// Holiday list ported from answers/is-earnest-money-due-on-weekends-texas/
// index.html (verified against Tex. Gov't Code §662.003) — do not re-derive:
//   §662.003(a) national holidays:
//     Jan 1 (New Year's Day), 3rd Mon Jan (MLK Day), 3rd Mon Feb
//     (Presidents' Day), last Mon May (Memorial Day), Jul 4 (Independence
//     Day), 1st Mon Sep (Labor Day), Nov 11 (Veterans Day), 4th Thu Nov
//     (Thanksgiving Day), Dec 25 (Christmas Day)
//   plus §662.003(b)(4) Juneteenth (Jun 19) and §662.003(b)(6) the Friday
//   after Thanksgiving — both trigger ¶5A(2) rollover even though neither
//   is on the federal list.
//   Texas-only observances (Confederate Heroes Day, Texas Independence Day,
//   etc.) are deliberately EXCLUDED — they fall outside §662.003(a)/(b)(4)/
//   (b)(6) and title companies do not treat them as rollover days.
//
// CRITICAL SCOPE RULE (¶5A(2)): the weekend/Legal-Holiday rollover applies
// ONLY to option fee, earnest money, and additional earnest money delivery
// deadlines. It does NOT apply to option expiration, title review, survey,
// financing/loan approval, appraisal, possession, or closing — those are
// fixed calendar dates even when they land on a weekend. That is encoded
// per deadline type in ROLLOVER_APPLIES below and enforced by
// applyTrecRollover(), which throws on any type not explicitly registered.

'use strict';

// ---------------------------------------------------------------------------
// YMD helpers — all math on 'YYYY-MM-DD' strings via Date.UTC so results are
// timezone-independent (same convention as cron-deadline-reminders.js).
// ---------------------------------------------------------------------------

function ymdToUTCDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function utcDateToYMD(dt) {
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function addCalendarDaysYMD(ymd, n) {
  const dt = ymdToUTCDate(ymd);
  dt.setUTCDate(dt.getUTCDate() + n);
  return utcDateToYMD(dt);
}

// 0 = Sunday ... 6 = Saturday
function dayOfWeekYMD(ymd) {
  return ymdToUTCDate(ymd).getUTCDay();
}

// Normalize a date-ish value to 'YYYY-MM-DD' or null. Accepts YMD, ISO
// timestamps, and US 'M/D/YYYY'. Anything else -> null (never guess).
function normalizeYMD(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); // YMD or ISO timestamp prefix
  if (m) {
    const ymd = `${m[1]}-${m[2]}-${m[3]}`;
    return utcDateToYMD(ymdToUTCDate(ymd)) === ymd ? ymd : null; // reject e.g. 2026-02-31
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // M/D/YYYY
  if (m) {
    const ymd = `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
    return utcDateToYMD(ymdToUTCDate(ymd)) === ymd ? ymd : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Texas Legal Holidays
// ---------------------------------------------------------------------------

// nth occurrence (1-based) of weekday (0=Sun..6=Sat) in month (1-12).
function nthWeekdayYMD(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return utcDateToYMD(new Date(Date.UTC(year, month - 1, 1 + offset + (n - 1) * 7)));
}

// last occurrence of weekday in month.
function lastWeekdayYMD(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last day
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return utcDateToYMD(new Date(Date.UTC(year, month, 0 - offset)));
}

// Set of 'YYYY-MM-DD' Legal Holidays for a given year, per the list above.
function texasLegalHolidays(year) {
  const thanksgiving = nthWeekdayYMD(year, 11, 4, 4); // 4th Thursday of November
  return new Set([
    `${year}-01-01`,                    // New Year's Day
    nthWeekdayYMD(year, 1, 1, 3),       // MLK Day — 3rd Monday of January
    nthWeekdayYMD(year, 2, 1, 3),       // Presidents' Day — 3rd Monday of February
    lastWeekdayYMD(year, 5, 1),         // Memorial Day — last Monday of May
    `${year}-06-19`,                    // Juneteenth — §662.003(b)(4)
    `${year}-07-04`,                    // Independence Day
    nthWeekdayYMD(year, 9, 1, 1),       // Labor Day — 1st Monday of September
    `${year}-11-11`,                    // Veterans Day
    thanksgiving,                       // Thanksgiving Day
    addCalendarDaysYMD(thanksgiving, 1),// Friday after Thanksgiving — §662.003(b)(6)
    `${year}-12-25`,                    // Christmas Day
  ]);
}

const holidayCache = new Map();

function isTexasLegalHoliday(ymd) {
  const year = Number(ymd.slice(0, 4));
  if (!holidayCache.has(year)) holidayCache.set(year, texasLegalHolidays(year));
  return holidayCache.get(year).has(ymd);
}

function isWeekendOrTexasLegalHoliday(ymd) {
  const dow = dayOfWeekYMD(ymd);
  if (dow === 0 || dow === 6) return true;
  return isTexasLegalHoliday(ymd);
}

// ¶5A(2): "if the last day ... is a Saturday, Sunday, or Legal Holiday, the
// time ... is extended until the end of the next day that is not". Rolls
// repeatedly (Sat -> Sun -> holiday Monday -> Tuesday).
function rollForwardYMD(ymd) {
  let out = ymd;
  while (isWeekendOrTexasLegalHoliday(out)) {
    out = addCalendarDaysYMD(out, 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-deadline-type rollover scope — the ¶5A(2) rule is NOT a blanket rule.
// ---------------------------------------------------------------------------

const ROLLOVER_APPLIES = {
  // ¶5A(2) rollover deadlines — funds delivery only.
  option_fee_due_date: true,
  earnest_money_due_date: true,
  additional_earnest_money_due_date: true,
  // Fixed calendar dates — NEVER roll, even on a weekend or Legal Holiday.
  option_expiration_date: false,
  closing_date: false,
  appraisal_deadline: false,
  survey_deadline: false,
  hoa_document_deadline: false,
  loan_approval_deadline: false,
  possession_date: false,
  title_commitment_effective_date: false,
};

// Apply ¶5A(2) rollover if — and only if — it applies to this deadline type.
// Throws on an unregistered type so a future caller can't silently get the
// scope rule wrong in either direction.
function applyTrecRollover(deadlineType, ymd) {
  if (!(deadlineType in ROLLOVER_APPLIES)) {
    throw new Error(`business-calendar: unknown deadline type "${deadlineType}" — register it in ROLLOVER_APPLIES with an explicit true/false`);
  }
  return ROLLOVER_APPLIES[deadlineType] ? rollForwardYMD(ymd) : ymd;
}

// ---------------------------------------------------------------------------
// TREC ¶5.A funds delivery due dates
// ---------------------------------------------------------------------------

// ¶5.A default: option fee and earnest money are due 3 calendar days after
// the Effective Date (the count itself is calendar days — weekends included),
// then ¶5A(2) rollover applies to the resulting date.
const TREC_5A_DELIVERY_DAYS = 3;

// Compute { option_fee_due_date, earnest_money_due_date } from a contract
// effective date. Returns { option_fee_due_date: null, earnest_money_due_date:
// null } when the input is empty/unparseable — callers use this to clear the
// due dates when the effective date is cleared.
function computeFundsDeliveryDueDates(effectiveDate) {
  const effective = normalizeYMD(effectiveDate);
  if (!effective) return { option_fee_due_date: null, earnest_money_due_date: null };
  const raw = addCalendarDaysYMD(effective, TREC_5A_DELIVERY_DAYS);
  return {
    option_fee_due_date: applyTrecRollover('option_fee_due_date', raw),
    earnest_money_due_date: applyTrecRollover('earnest_money_due_date', raw),
  };
}

module.exports = {
  TREC_5A_DELIVERY_DAYS,
  ROLLOVER_APPLIES,
  normalizeYMD,
  addCalendarDaysYMD,
  dayOfWeekYMD,
  texasLegalHolidays,
  isTexasLegalHoliday,
  isWeekendOrTexasLegalHoliday,
  rollForwardYMD,
  applyTrecRollover,
  computeFundsDeliveryDueDates,
};
