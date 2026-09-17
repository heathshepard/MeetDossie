#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-03 CARTER build of Deadline Guardian
 * checklist item #1 (docs/DOSSIE-DEADLINE-GUARDIAN-SPEC.md):
 * option fee / earnest money delivery deadlines.
 *
 * Pre-fix state this test proves against:
 *   - api/_lib/business-calendar.js did not exist (no Texas Legal Holiday
 *     table, no ¶5A(2) rollover anywhere in code).
 *   - cron-deadline-reminders.js DEADLINE_FIELDS had no option_fee_due_date /
 *     earnest_money_due_date at all — the two deadlines behind the real
 *     $5,200 loss produced zero reminders.
 *
 * Covers:
 *   1. Calendar math (TREC ¶5.A: effective + 3 calendar days, then ¶5A(2)
 *      weekend/Texas-Legal-Holiday rollover):
 *        - Friday effective -> Monday, NO rollover (the exact source case)
 *        - Wednesday effective -> Saturday -> rolls to Monday
 *        - Rolls across Labor Day (Mon 2026-09-07) to Tuesday 2026-09-08
 *        - Juneteenth + Friday-after-Thanksgiving are §662.003(b)(4)/(b)(6)
 *          rollover days
 *   2. Rollover SCOPE: ¶5A(2) applies ONLY to funds delivery — option
 *      expiration / closing / survey etc. never roll; unknown deadline
 *      types throw instead of silently guessing.
 *   3. Cron wiring: both fields in DEADLINE_FIELDS with a T-3/T-1/T-0
 *      schedule (a 3-day window can never hit T-7), CONFIRMED-RECEIPT
 *      suppression (option_fee_confirmed_at / earnest_money_confirmed_at
 *      only — never the self-reported option_fee_paid_at /
 *      earnest_money_deposited_at), and in-memory derivation from
 *      contract_effective_date when the due-date columns are NULL.
 *      Standard fields keep T-7/T-1/T-0.
 *
 * 2026-09-17 correction. The suppression cases in this file were red on main
 * for a week and both sides were wrong:
 *   - The TEST asserted suppression on `option_fee_receipt_date`, which is a
 *     TREC 20-19 AcroForm field key (page-11 receipt block), not a column on
 *     public.transactions. Selecting it 400s PostgREST — that is exactly what
 *     500'd this cron for every customer for a week (fe4311b2, 2026-09-10).
 *   - The CODE, after that hotfix, suppressed on `option_fee_paid_at`, which
 *     the workspace stamps with the UPLOAD TIME the moment an executed
 *     contract showing any option fee amount is scanned. The reminder went
 *     quiet on day zero, before delivery — the Low Oak $5,200 failure mode.
 * The fix introduced `option_fee_confirmed_at` (20260917e migration) as the
 * option-fee peer of the existing `earnest_money_confirmed_at`, and both
 * deadlines now suppress on confirmed receipt only.
 *
 * Run manually:
 *   node scripts/regression-funds-delivery-due-dates.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const BC_PATH = path.resolve(__dirname, '..', 'api', '_lib', 'business-calendar.js');
const CRON_PATH = path.resolve(__dirname, '..', 'api', 'cron-deadline-reminders.js');

async function main() {
  console.log('funds delivery due dates regression — Deadline Guardian checklist #1 (2026-09-03)');
  console.log('=========================================================================================');

  assert.ok(fs.existsSync(BC_PATH), `business-calendar module missing at ${BC_PATH} (pre-fix code)`);
  const bc = require(BC_PATH);
  const cron = require(CRON_PATH);
  assert.ok(cron.__test && Array.isArray(cron.__test.DEADLINE_FIELDS),
    'cron-deadline-reminders.js does not expose __test.DEADLINE_FIELDS (pre-fix code)');
  const {
    DEADLINE_FIELDS, REMINDER_MILESTONES, ALL_MILESTONES,
    SUPPRESSION_FIELDS, SELECT_OPTIONAL,
  } = cron.__test;
  assert.ok(Array.isArray(SUPPRESSION_FIELDS),
    'cron-deadline-reminders.js does not expose __test.SUPPRESSION_FIELDS');
  assert.ok(SELECT_OPTIONAL instanceof Set,
    'cron-deadline-reminders.js does not expose __test.SELECT_OPTIONAL');

  const due = (effective) => bc.computeFundsDeliveryDueDates(effective);

  const CASES = [
    // --- 1. Calendar math -------------------------------------------------
    ['Friday effective (2026-08-21) -> due Monday 2026-08-24, NO rollover (the source case)',
      () => {
        const d = due('2026-08-21');
        assert.strictEqual(d.option_fee_due_date, '2026-08-24');
        assert.strictEqual(d.earnest_money_due_date, '2026-08-24');
        assert.strictEqual(bc.dayOfWeekYMD('2026-08-21'), 5, 'fixture must be a Friday');
        assert.strictEqual(bc.dayOfWeekYMD('2026-08-24'), 1, 'result must be a Monday');
      }],
    ['Wednesday effective (2026-09-09) lands Saturday 09-12 -> rolls to Monday 2026-09-14',
      () => {
        assert.strictEqual(bc.dayOfWeekYMD('2026-09-09'), 3, 'fixture must be a Wednesday');
        assert.strictEqual(due('2026-09-09').earnest_money_due_date, '2026-09-14');
      }],
    ['Rolls across Labor Day: 2026-09-02 -> Sat 09-05 -> Sun -> Labor Day Mon 09-07 -> Tue 2026-09-08',
      () => {
        assert.strictEqual(bc.dayOfWeekYMD('2026-09-07'), 1, '2026-09-07 must be a Monday');
        assert.ok(bc.isTexasLegalHoliday('2026-09-07'), 'Labor Day 2026-09-07 must be a Texas Legal Holiday');
        assert.strictEqual(due('2026-09-02').option_fee_due_date, '2026-09-08');
        assert.strictEqual(due('2026-09-02').earnest_money_due_date, '2026-09-08');
      }],
    ['Juneteenth is a §662.003(b)(4) rollover day: 2026-06-16 -> Fri Jun 19 -> Mon 2026-06-22',
      () => {
        assert.ok(bc.isTexasLegalHoliday('2026-06-19'), 'Juneteenth must be in the holiday table');
        assert.strictEqual(due('2026-06-16').earnest_money_due_date, '2026-06-22');
      }],
    ['Friday after Thanksgiving is a §662.003(b)(6) rollover day: 2026-11-23 -> Thu 11-26 -> Mon 2026-11-30',
      () => {
        assert.ok(bc.isTexasLegalHoliday('2026-11-26'), 'Thanksgiving must be in the holiday table');
        assert.ok(bc.isTexasLegalHoliday('2026-11-27'), 'Friday after Thanksgiving must be in the holiday table');
        assert.strictEqual(due('2026-11-23').earnest_money_due_date, '2026-11-30');
      }],
    ['Texas-only observances are NOT rollover days (Confederate Heroes Day Jan 19 only counts when it is MLK Day)',
      () => {
        // 2027-01-19 is a Tuesday and not the 3rd Monday — must not be a holiday.
        assert.strictEqual(bc.isTexasLegalHoliday('2027-01-19'), false);
        // Texas Independence Day, Mar 2 — never in §662.003(a)/(b)(4)/(b)(6).
        assert.strictEqual(bc.isTexasLegalHoliday('2026-03-02'), false);
      }],
    ['Input formats: ISO timestamp and M/D/YYYY normalize; junk clears to null without guessing',
      () => {
        assert.strictEqual(due('2026-08-21T13:23:00Z').option_fee_due_date, '2026-08-24');
        assert.strictEqual(due('8/21/2026').option_fee_due_date, '2026-08-24');
        assert.deepStrictEqual(due('next friday'), { option_fee_due_date: null, earnest_money_due_date: null });
        assert.deepStrictEqual(due(null), { option_fee_due_date: null, earnest_money_due_date: null });
        assert.deepStrictEqual(due(''), { option_fee_due_date: null, earnest_money_due_date: null });
      }],

    // --- 2. Rollover scope is per deadline type, never blanket ------------
    ['¶5A(2) rollover does NOT apply to option expiration / closing / survey (fixed calendar dates)',
      () => {
        assert.strictEqual(bc.applyTrecRollover('option_expiration_date', '2026-09-05'), '2026-09-05'); // Saturday stays
        assert.strictEqual(bc.applyTrecRollover('closing_date', '2026-09-07'), '2026-09-07');           // Labor Day stays
        assert.strictEqual(bc.applyTrecRollover('survey_deadline', '2026-09-06'), '2026-09-06');        // Sunday stays
        assert.strictEqual(bc.applyTrecRollover('appraisal_deadline', '2026-09-05'), '2026-09-05');
        assert.strictEqual(bc.applyTrecRollover('loan_approval_deadline', '2026-09-05'), '2026-09-05');
      }],
    ['¶5A(2) rollover DOES apply to the funds delivery deadlines',
      () => {
        assert.strictEqual(bc.applyTrecRollover('option_fee_due_date', '2026-09-05'), '2026-09-08');
        assert.strictEqual(bc.applyTrecRollover('earnest_money_due_date', '2026-09-05'), '2026-09-08');
        assert.strictEqual(bc.applyTrecRollover('additional_earnest_money_due_date', '2026-09-05'), '2026-09-08');
      }],
    ['Unknown deadline type throws — no silent blanket rule in either direction',
      () => assert.throws(() => bc.applyTrecRollover('made_up_deadline', '2026-09-05'), /unknown deadline type/)],

    // --- 3. Cron wiring ---------------------------------------------------
    ['DEADLINE_FIELDS tracks option_fee_due_date and earnest_money_due_date',
      () => {
        assert.ok(DEADLINE_FIELDS.some((f) => f.col === 'option_fee_due_date'), 'option_fee_due_date missing from DEADLINE_FIELDS');
        assert.ok(DEADLINE_FIELDS.some((f) => f.col === 'earnest_money_due_date'), 'earnest_money_due_date missing from DEADLINE_FIELDS');
      }],
    ['Both funds-delivery fields run T-3/T-1/T-0 (a 3-day window can never hit T-7)',
      () => {
        for (const col of ['option_fee_due_date', 'earnest_money_due_date']) {
          const f = DEADLINE_FIELDS.find((x) => x.col === col);
          assert.deepStrictEqual(f.milestones, [3, 1, 0], `${col} milestones`);
        }
        assert.ok(ALL_MILESTONES.includes(3), 'target dates must include T-3');
      }],
    ['Standard fields keep the default T-7/T-1/T-0 — the new T-3 target must not leak into them',
      () => {
        assert.deepStrictEqual(REMINDER_MILESTONES, [7, 1, 0]);
        for (const col of ['option_expiration_date', 'closing_date', 'appraisal_deadline']) {
          const f = DEADLINE_FIELDS.find((x) => x.col === col);
          assert.strictEqual(f.milestones, undefined, `${col} must use the default schedule`);
        }
      }],
    ['Receipt suppression: reminder stops once funds are CONFIRMED received (never nags after receipt)',
      () => {
        const of = DEADLINE_FIELDS.find((x) => x.col === 'option_fee_due_date');
        const em = DEADLINE_FIELDS.find((x) => x.col === 'earnest_money_due_date');
        assert.strictEqual(of.suppressWhen({ option_fee_confirmed_at: '2026-08-24T10:00:00Z' }), true);
        assert.strictEqual(of.suppressWhen({ option_fee_confirmed_at: null }), false);
        assert.strictEqual(em.suppressWhen({ earnest_money_confirmed_at: '2026-08-24T10:00:00Z' }), true);
        assert.strictEqual(em.suppressWhen({ earnest_money_confirmed_at: null }), false);
        // Nothing set at all -> remind. Suppression is opt-in on evidence.
        assert.strictEqual(of.suppressWhen({}), false);
        assert.strictEqual(em.suppressWhen({}), false);
      }],
    ['Suppression is NOT triggered by self-reported sent/paid fields (sent != received, spec Gate 6)',
      () => {
        const of = DEADLINE_FIELDS.find((x) => x.col === 'option_fee_due_date');
        const em = DEADLINE_FIELDS.find((x) => x.col === 'earnest_money_due_date');
        // option_fee_paid_at / earnest_money_deposited_at are stamped with the
        // UPLOAD TIME when an executed contract is scanned and para 5.A shows
        // an amount. Suppressing on them silenced the reminder on day zero,
        // before anyone delivered anything — the Low Oak $5,200 failure mode.
        assert.strictEqual(
          of.suppressWhen({ option_fee_paid_at: '2026-08-24T10:00:00Z', option_fee_confirmed_at: null }), false,
          'option fee: "marked paid" must not silence the delivery reminder');
        assert.strictEqual(
          of.suppressWhen({ option_fee_paid_to: 'Alamo Title', option_fee_confirmed_at: null }), false,
          'option fee: naming a payee must not silence the delivery reminder');
        assert.strictEqual(
          em.suppressWhen({ earnest_money_deposited_at: '2026-08-24T10:00:00Z', earnest_money_confirmed_at: null }), false,
          'earnest money: "deposit sent" must not silence the delivery reminder');
      }],
    ['Suppressors read ONLY columns the cron actually selects (no phantom-column suppression)',
      () => {
        // The root cause of the 2026-09-10 outage AND of this bug: a suppressor
        // naming a column that is not in the select is permanently undefined
        // (silently never suppresses), and a select naming a column that does
        // not exist 400s PostgREST and kills every reminder for every customer.
        // option_fee_receipt_date was the culprit both times — it is a TREC
        // 20-19 AcroForm field key, never a transactions column.
        const selected = new Set(SUPPRESSION_FIELDS);
        for (const col of ['option_fee_due_date', 'earnest_money_due_date']) {
          const f = DEADLINE_FIELDS.find((x) => x.col === col);
          const touched = [];
          f.suppressWhen(new Proxy({}, {
            get(_t, prop) { if (typeof prop === 'string') touched.push(prop); return undefined; },
            has() { return true; },
          }));
          assert.ok(touched.length > 0, `${col} suppressWhen read no fields at all`);
          for (const prop of touched) {
            assert.ok(selected.has(prop),
              `${col} suppressWhen reads "${prop}", which is not in SUPPRESSION_FIELDS — the cron never fetches it, so it can never suppress`);
          }
        }
        assert.ok(!SUPPRESSION_FIELDS.includes('option_fee_receipt_date'),
          'option_fee_receipt_date is a TREC PDF field key, not a transactions column — selecting it 400s PostgREST');
      }],
    ['Self-reported fields are not even fetched, so they cannot be wired back in by accident',
      () => {
        for (const col of ['option_fee_paid_at', 'earnest_money_deposited_at']) {
          assert.ok(!SUPPRESSION_FIELDS.includes(col),
            `${col} is self-reported and must not be in the suppression field set`);
        }
      }],
    ['Columns pending a migration are marked optional so a missing one cannot zero out the cron',
      () => {
        assert.ok(SELECT_OPTIONAL instanceof Set, 'SELECT_OPTIONAL must be a Set');
        for (const col of SELECT_OPTIONAL) {
          assert.ok(SUPPRESSION_FIELDS.includes(col),
            `${col} is marked optional but is not a suppression field — optional columns exist only to be droppable`);
        }
      }],
    ['NULL due-date column falls back to in-memory derivation from contract_effective_date',
      () => {
        const of = DEADLINE_FIELDS.find((x) => x.col === 'option_fee_due_date');
        const em = DEADLINE_FIELDS.find((x) => x.col === 'earnest_money_due_date');
        const tx = { contract_effective_date: '2026-08-21', option_fee_due_date: null, earnest_money_due_date: null };
        assert.strictEqual(of.deriveFrom(tx), '2026-08-24');
        assert.strictEqual(em.deriveFrom(tx), '2026-08-24');
        assert.strictEqual(of.deriveFrom({ contract_effective_date: null }), null, 'no effective date -> no derived deadline');
      }],
  ];

  let failed = 0;
  for (const [label, fn] of CASES) {
    try {
      await fn();
      console.log('  PASS:', label);
    } catch (e) {
      failed++;
      console.error('  FAIL:', label, '—', e && e.message);
    }
  }
  console.log('=========================================================================================');
  if (failed) {
    console.log(failed + ' test(s) FAILED');
    process.exit(1);
  }
  console.log('All tests passed');
}

main().catch((e) => {
  console.error('FATAL:', (e && e.stack) || e);
  process.exit(1);
});
