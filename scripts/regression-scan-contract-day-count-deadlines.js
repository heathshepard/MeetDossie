#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 23 Nopalito wrong-survey-deadline incident
 * (transaction 952e0d82-c453-4137-87b4-1ed46e738eb3, 2026-09-22).
 *
 * Live failure: survey_deadline was stored as 2026-09-24 and reached Heath's
 * sellers. The executed contract's checked ¶6C(1) box reads "Within 14 days
 * after the Effective Date of this contract..." — effective date 2026-09-20,
 * so the correct deadline is 2026-10-04, not 2026-09-24 (off by 10 days).
 *
 * Root cause: api/scan-contract.js's deterministic regex backstop for
 * surveyDeadline (and the equivalent backstops for financingDays/
 * loanApprovalDeadline, appraisalDeadline, hoaDocumentDeadline) only ever
 * OVERRODE the model's own top-level date guess when the regex found a
 * match against the verbatim debug-paragraph text. When it did NOT match,
 * the code silently kept whatever the model itself guessed — a field the
 * extraction prompt itself documents as "a secondary check only... getting
 * this exactly right yourself is not critical." A wrong deadline is a money
 * error, not a display error — an unknown deadline must read as unknown,
 * never as a confident wrong date.
 *
 * Fix: api/scan-contract.js's applyDeterministicDeadlineOverrides() now
 * ALWAYS derives these fields from ONLY the deterministic day-count parse.
 * If the debug paragraph exists but no day count can be verified, the field
 * is forced to null (unknown) — even if the model had already guessed a
 * (possibly wrong) date. A `<field>Days` sibling is written alongside each
 * deadline so the source day count is recoverable for a human to check the
 * arithmetic (persisted via transactions.contract_extraction).
 *
 * Covers:
 *   1. The real 23 Nopalito shape: ¶6C(1) checked, 14 days, non-default day
 *      count — must produce 2026-10-04, not the shipped-wrong 2026-09-24 and
 *      not any hardcoded default.
 *   2. Empty/unreadable blank on the checked option (day count never filled
 *      in) — must produce null (unknown), even though a bad model guess was
 *      already sitting in the field, never a substituted default.
 *   3. ¶6C(2) and ¶6C(3) elections — same "days after Effective Date" shape,
 *      must compute identically to ¶6C(1), and sellerProvidesSurvey must
 *      read false for both (only ¶6C(1) means seller furnishes the existing
 *      survey).
 *   4. No debug paragraph captured at all (e.g. extraction gap) — field is
 *      left alone (should already be null from the extraction prompt), not
 *      forced to a wrong default.
 *   5. Same "always deterministic, never an unverified guess" shape checked
 *      for financingDays/loanApprovalDeadline, appraisalDeadline, and
 *      hoaDocumentDeadline — the other three day-count-derived deadlines
 *      flagged in the same audit.
 *
 * Run manually:
 *   node scripts/regression-scan-contract-day-count-deadlines.js
 */

const assert = require('assert');
const path = require('path');

const SCAN_CONTRACT_PATH = path.resolve(__dirname, '..', 'api', 'scan-contract.js');

async function main() {
  console.log('scan-contract day-count deadline regression — 23 Nopalito (2026-09-22)');
  console.log('=========================================================================================');

  const { applyDeterministicDeadlineOverrides } = require(SCAN_CONTRACT_PATH);
  assert.strictEqual(typeof applyDeterministicDeadlineOverrides, 'function', 'applyDeterministicDeadlineOverrides must be exported from api/scan-contract.js');

  // --- 1. Real 23 Nopalito shape -------------------------------------------------
  {
    const extracted = {
      contractEffectiveDate: '2026-09-20',
      surveyDeadline: '2026-09-24', // the wrong value that actually shipped
      debugParagraph6C:
        "[X] (1) Within 14 days after the Effective Date of this contract, Seller shall furnish to Buyer "
        + "and Title Company Seller's existing survey of the Property and a Residential Real Property "
        + "Affidavit or Declaration promulgated by the Texas Department of Insurance (T-47 Affidavit or "
        + "T-47.1 Declaration). Buyer shall obtain a new survey at Seller's expense no later than 3 days "
        + "prior to Closing Date if Seller fails to furnish within the time prescribed both the: (i) existing "
        + "survey; and (ii) affidavit or declaration. If the Title Company or Buyer's lender does not accept "
        + "the existing survey, or the affidavit or declaration, Buyer shall obtain a new survey at Seller's "
        + "[X] Buyer's expense no later than 3 days prior to Closing Date. "
        + "[ ] (2) Within  days after the Effective Date of this contract, Buyer may obtain a new survey at "
        + "Buyer's expense. "
        + "[ ] (3) Within  days after the Effective Date of this contract, Seller, at Seller's expense shall "
        + 'furnish a new survey to Buyer.',
      addenda: {},
    };
    applyDeterministicDeadlineOverrides(extracted);
    assert.strictEqual(extracted.surveyDeadline, '2026-10-04', `23 Nopalito must compute 2026-10-04, got ${extracted.surveyDeadline}`);
    assert.notStrictEqual(extracted.surveyDeadline, '2026-09-24', 'must not reproduce the shipped-wrong date');
    assert.strictEqual(extracted.surveyDeadlineDays, 14, 'source day count must be recoverable for audit');
    assert.strictEqual(extracted.sellerProvidesSurvey, true, '¶6C(1) checked means seller furnishes existing survey');
    console.log('  [PASS] 23 Nopalito real shape -> 2026-10-04 (14 days), not 2026-09-24');
  }

  // --- 2. Empty/unreadable blank on the checked option ---------------------------
  {
    const extracted = {
      contractEffectiveDate: '2026-09-20',
      surveyDeadline: '2026-09-24', // stale bad guess must be discarded, not kept
      debugParagraph6C:
        '[ ] (1) Within 14 days... '
        + "[X] (2) Within  days after the Effective Date of this contract, Buyer may obtain a new survey at Buyer's expense. "
        + "[ ] (3) Within  days after the Effective Date of this contract, Seller, at Seller's expense shall furnish a new survey to Buyer.",
      addenda: {},
    };
    applyDeterministicDeadlineOverrides(extracted);
    assert.strictEqual(extracted.surveyDeadline, null, 'unfilled day-count blank must read as unknown (null), never a default or a stale guess');
    assert.strictEqual(extracted.surveyDeadlineDays, null);
    console.log('  [PASS] empty day-count blank -> null (unknown), never a default or stale guess');
  }

  // --- 3. ¶6C(2) and ¶6C(3) with a real day count ---------------------------------
  {
    const extracted2 = {
      contractEffectiveDate: '2026-09-20',
      surveyDeadline: null,
      debugParagraph6C:
        '[ ] (1) Within 14 days... '
        + "[X] (2) Within 10 days after the Effective Date of this contract, Buyer may obtain a new survey at Buyer's expense. "
        + "[ ] (3) Within  days after the Effective Date of this contract, Seller, at Seller's expense shall furnish a new survey to Buyer.",
      addenda: {},
    };
    applyDeterministicDeadlineOverrides(extracted2);
    assert.strictEqual(extracted2.surveyDeadline, '2026-09-30', '¶6C(2) uses the same days-after-effective-date math');
    assert.strictEqual(extracted2.sellerProvidesSurvey, false, '¶6C(2) means buyer obtains, not seller furnishes existing');

    const extracted3 = {
      contractEffectiveDate: '2026-09-20',
      surveyDeadline: null,
      debugParagraph6C:
        '[ ] (1) Within 14 days... '
        + "[ ] (2) Within  days after the Effective Date of this contract, Buyer may obtain a new survey at Buyer's expense. "
        + "[X] (3) Within 20 days after the Effective Date of this contract, Seller, at Seller's expense shall furnish a new survey to Buyer.",
      addenda: {},
    };
    applyDeterministicDeadlineOverrides(extracted3);
    assert.strictEqual(extracted3.surveyDeadline, '2026-10-10', '¶6C(3) uses the same days-after-effective-date math');
    assert.strictEqual(extracted3.sellerProvidesSurvey, false, '¶6C(3) means seller obtains a NEW survey, not furnishes the existing one');
    console.log('  [PASS] ¶6C(2) and ¶6C(3) elections compute correctly and sellerProvidesSurvey is false for both');
  }

  // --- 4. No debug paragraph captured at all --------------------------------------
  {
    const extracted = { contractEffectiveDate: '2026-09-20', surveyDeadline: null, debugParagraph6C: null, addenda: {} };
    applyDeterministicDeadlineOverrides(extracted);
    assert.strictEqual(extracted.surveyDeadline, null);
    console.log('  [PASS] missing debug paragraph -> left null, not defaulted');
  }

  // --- 5. Same shape: financing / appraisal / HOA ---------------------------------
  {
    const extracted = {
      contractEffectiveDate: '2026-09-20',
      financingDays: null,
      loanApprovalDeadline: null,
      debugThirdPartyFinancing: 'Buyer must give Lender written notice within 21 days after the Effective Date if Buyer cannot obtain financing approval.',
      addenda: {},
    };
    applyDeterministicDeadlineOverrides(extracted);
    assert.strictEqual(extracted.financingDays, 21);
    assert.strictEqual(extracted.loanApprovalDeadline, '2026-10-11');

    const badFinancing = {
      contractEffectiveDate: '2026-09-20',
      financingDays: 30,
      loanApprovalDeadline: '2026-10-20', // stale/possibly-wrong guess
      debugThirdPartyFinancing: 'Buyer must give Lender written notice within  days after the Effective Date.', // blank never filled in
      addenda: {},
    };
    applyDeterministicDeadlineOverrides(badFinancing);
    assert.strictEqual(badFinancing.financingDays, null, 'unreadable financing day count must not keep the stale guess');
    assert.strictEqual(badFinancing.loanApprovalDeadline, null);

    const appraisal = {
      contractEffectiveDate: '2026-09-20',
      appraisalDeadline: null,
      addenda: {},
      debugAppraisalAddendum: 'Buyer may terminate this contract within 10 days after the Effective Date if the appraised value is less than the Sales Price.',
    };
    applyDeterministicDeadlineOverrides(appraisal);
    assert.strictEqual(appraisal.appraisalDeadline, '2026-09-30');
    assert.strictEqual(appraisal.addenda.appraisalTerminationDays, 10);

    const hoa = {
      contractEffectiveDate: '2026-09-20',
      hoaDocumentDeadline: null,
      addenda: {},
      debugHoaAddendum: 'Seller shall deliver the subdivision information within 7 days after the Effective Date.',
    };
    applyDeterministicDeadlineOverrides(hoa);
    assert.strictEqual(hoa.hoaDocumentDeadline, '2026-09-27');
    assert.strictEqual(hoa.addenda.hoaDocumentDeadlineDays, 7);

    console.log('  [PASS] financing/appraisal/HOA deadlines: same deterministic-only, never-a-stale-guess shape');
  }

  console.log('=========================================================================================');
  console.log('ALL PASS');
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
