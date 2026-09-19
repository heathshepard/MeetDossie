'use strict';

// api/_lib/activation-flag-audit.js
//
// Telling a genuine send apart from a database backfill.
//
// THE PROBLEM
//   profiles.activation_email_{1,2,3}_sent_at are the only record of whether a
//   customer received the activation sequence, and they are not trustworthy.
//   Ten profiles carry the byte-identical value 2026-06-05 20:15:46.475638+00
//   in ALL THREE columns. Nobody sent thirty emails in the same microsecond.
//   Somebody ran `UPDATE profiles SET activation_email_1_sent_at = now(),
//   activation_email_2_sent_at = now(), activation_email_3_sent_at = now()`.
//
//   The drip gates on `activation_email_3_sent_at IS NULL`, so that one
//   statement permanently silenced the sequence for ten paying customers, four
//   of whom had received nothing at all. The drip was not broken. The data was.
//   See docs/ACTIVATION-FORENSICS-2026-09-18.md §4.
//
// THE TEST
//   Not a heuristic — a property of the two writers.
//
//     * The cron writes `new Date().toISOString()`. JavaScript Date has
//       MILLISECOND resolution, so every value it produces has microseconds
//       ending in exactly three zeros: .475000, .835000, .213000.
//
//     * Postgres `now()` has MICROSECOND resolution. Its sub-millisecond digits
//       are effectively random: .475638, .834038.
//
//   So: microsecond field % 1000 === 0  =>  written by the cron  =>  REAL.
//       microsecond field % 1000 !== 0  =>  written by raw SQL   =>  BACKFILL.
//
//   Verified against every non-null row in the live table on 2026-09-18:
//
//     us1     us2     us3     rows  verdict
//     475638  475638  475638  10    backfill (all three, identical)
//     835000  213000  150000  1     real (Suzanne — three separate cron runs)
//     834038  834038  909000  1     real only on #3 (Lisa — 1 and 2 backfilled,
//                                   3 genuinely sent 2026-06-11)
//
//   It splits 12 of 12 correctly and needs no per-customer judgement.
//
// THE ONE FALSE-POSITIVE DIRECTION, AND WHY IT IS THE SAFE ONE
//   A genuine `now()` write could land on an exact millisecond boundary about
//   once in a thousand times, and we would misread it as REAL. The consequence
//   of that mistake is that we leave a stamp alone and do NOT email anyone.
//   The opposite mistake — calling a real send a backfill — would put mail in a
//   real customer's inbox. The test is deliberately biased toward silence.
//
// CORROBORATION
//   Two or more columns holding the identical timestamp is independent evidence
//   of a single multi-column UPDATE: the cron writes one column per run, days
//   apart. Reported alongside the primary test, never used to override it.
//
// THIS MODULE SENDS NOTHING AND WRITES NOTHING. It is pure classification.
//
// Owner: 2026-09-18.

const ACTIVATION_COLUMNS = [
  'activation_email_1_sent_at',
  'activation_email_2_sent_at',
  'activation_email_3_sent_at',
];

/**
 * Sub-millisecond digits of a Postgres timestamptz string, or null if the
 * value has no fractional-second component we can read.
 *
 * Postgres renders timestamptz as '2026-06-05 20:15:46.475638+00' (PostgREST
 * gives '2026-06-05T20:15:46.475638+00:00'). We want the digits after the
 * first three of the fractional part.
 */
function subMillisecondDigits(value) {
  if (!value) return null;
  const m = String(value).match(/\.(\d+)/);
  if (!m) return null;
  // Pad/trim to exactly 6 digits (microseconds), the way Postgres stores it.
  const frac = (m[1] + '000000').slice(0, 6);
  const micros = parseInt(frac, 10);
  if (!Number.isFinite(micros)) return null;
  return micros % 1000;
}

/**
 * Classify a single timestamp.
 * @returns {'none'|'real'|'backfilled'|'indeterminate'}
 */
function classifyTimestamp(value) {
  if (!value) return 'none';
  const sub = subMillisecondDigits(value);
  // No fractional seconds at all — cannot tell. Treat as indeterminate, which
  // callers must handle like 'real' (i.e. leave it alone, send nothing).
  if (sub === null) return 'indeterminate';
  return sub === 0 ? 'real' : 'backfilled';
}

/**
 * Classify a profile's whole activation-email record.
 *
 * @param {object} profile - needs the three activation_email_*_sent_at columns
 * @returns {{
 *   steps: {[column: string]: 'none'|'real'|'backfilled'|'indeterminate'},
 *   anyBackfilled: boolean,
 *   allBackfilled: boolean,
 *   duplicateTimestamps: boolean,
 *   realSendCount: number,
 *   verdict: 'clean'|'partially_backfilled'|'fully_backfilled'
 * }}
 */
function classifyProfile(profile) {
  const steps = {};
  const seen = new Map();
  let backfilled = 0;
  let realSends = 0;
  let present = 0;

  for (const col of ACTIVATION_COLUMNS) {
    const v = profile ? profile[col] : null;
    const verdict = classifyTimestamp(v);
    steps[col] = verdict;
    if (verdict !== 'none') {
      present += 1;
      const key = String(v);
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    if (verdict === 'backfilled') backfilled += 1;
    // 'indeterminate' counts as real for safety: we will not re-send on a guess.
    if (verdict === 'real' || verdict === 'indeterminate') realSends += 1;
  }

  let duplicateTimestamps = false;
  for (const count of seen.values()) if (count > 1) duplicateTimestamps = true;

  let verdict = 'clean';
  if (backfilled > 0) {
    verdict = (backfilled === present && present > 0) ? 'fully_backfilled' : 'partially_backfilled';
  }

  return {
    steps,
    anyBackfilled: backfilled > 0,
    allBackfilled: present > 0 && backfilled === present,
    duplicateTimestamps,
    realSendCount: realSends,
    verdict,
  };
}

/**
 * Does this profile hold a TRUSTWORTHY record that the given step was sent?
 *
 * This is the predicate the drip must gate on instead of a bare
 * `column IS NULL`. Order of authority:
 *
 *   1. The lifecycle_email_log ledger, when we have one. A row there means
 *      Resend accepted the message and returned an id — that is real evidence.
 *   2. Failing that, the profile column, but ONLY if it passes the
 *      millisecond test. A backfilled stamp is not evidence of anything.
 *
 * @param {object} profile
 * @param {string} column - one of ACTIVATION_COLUMNS
 * @param {Set<string>|undefined} ledgerSteps - e.g. Set('activation:email_1')
 * @param {string} ledgerKey - e.g. 'activation:email_1'
 */
function wasGenuinelySent(profile, column, ledgerSteps, ledgerKey) {
  if (ledgerSteps && ledgerKey && ledgerSteps.has(ledgerKey)) return true;
  const verdict = classifyTimestamp(profile ? profile[column] : null);
  return verdict === 'real' || verdict === 'indeterminate';
}

module.exports = {
  ACTIVATION_COLUMNS,
  subMillisecondDigits,
  classifyTimestamp,
  classifyProfile,
  wasGenuinelySent,
};
