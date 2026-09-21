// api/_lib/contract-term-persistence.test.js
//
// Run with: node --test api/_lib/contract-term-persistence.test.js
//
// The single question every test here answers: does Rule 1 actually hold —
// a human value always wins, a parsed value that disagrees is a conflict,
// never a silent overwrite?

const test = require('node:test');
const assert = require('node:assert/strict');

const { planContractTermWrites, TERM_FIELD_MAP } = require('./contract-term-persistence');

const SOURCE = { document_id: 'doc-1', file_name: 'contract.pdf', document_label: 'the contract' };

test('a blank field is filled from the extraction', () => {
  const plan = planContractTermWrites({
    tx: { closing_date: null },
    extracted: { closingDate: '2026-10-22' },
    documentTypeConfidence: 1,
    source: SOURCE,
  });
  assert.equal(plan.updates.closing_date, '2026-10-22');
  assert.equal(plan.filled.length, 1);
  assert.equal(plan.conflicts.length, 0);
});

test('a field that already has a DIFFERENT value is never overwritten — it becomes a conflict', () => {
  const plan = planContractTermWrites({
    tx: { closing_date: '2026-10-15' },
    extracted: { closingDate: '2026-10-22' },
    documentTypeConfidence: 1,
    source: SOURCE,
  });
  assert.equal(plan.updates.closing_date, undefined, 'must not be staged for write');
  assert.equal(plan.filled.length, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].column, 'closing_date');
  assert.equal(plan.conflicts[0].existing, '2026-10-15');
  assert.equal(plan.conflicts[0].parsed, '2026-10-22');
});

test('a field that already has the SAME value is neither filled nor conflicted', () => {
  const plan = planContractTermWrites({
    tx: { closing_date: '2026-10-22' },
    extracted: { closingDate: '2026-10-22' },
    documentTypeConfidence: 1,
    source: SOURCE,
  });
  assert.equal(Object.keys(plan.updates).length, 0);
  assert.equal(plan.filled.length, 0);
  assert.equal(plan.conflicts.length, 0);
});

test('a numeric field of exactly 0 counts as blank, not a real zero — still fillable', () => {
  const plan = planContractTermWrites({
    tx: { option_fee: 0 },
    extracted: { optionFee: 250 },
    documentTypeConfidence: 1,
    source: SOURCE,
  });
  assert.equal(plan.updates.option_fee, 250);
});

test('a numeric extraction of 0 or negative is never written — indistinguishable from unset', () => {
  const plan = planContractTermWrites({
    tx: { option_fee: null },
    extracted: { optionFee: 0 },
    documentTypeConfidence: 1,
    source: SOURCE,
  });
  assert.equal(plan.updates.option_fee, undefined);
  assert.equal(plan.filled.length, 0);
});

test('below the confidence gate, nothing is filled and nothing is flagged as a conflict', () => {
  const plan = planContractTermWrites({
    tx: { closing_date: null, sale_price: null },
    extracted: { closingDate: '2026-10-22', salePrice: 999000 },
    documentTypeConfidence: 0.5,
    source: SOURCE,
  });
  assert.equal(Object.keys(plan.updates).length, 0);
  assert.equal(plan.filled.length, 0);
  assert.equal(plan.conflicts.length, 0);
  assert.ok(plan.skippedLowConfidence.length > 0);
});

test('every TERM_FIELD_MAP column is a snake_case transactions column, never a payment-EVENT field', () => {
  const forbidden = ['earnest_money_deposited_at', 'option_fee_paid_at', 'earnest_money_confirmed_at'];
  for (const f of TERM_FIELD_MAP) {
    assert.ok(!forbidden.includes(f.column), `${f.column} is a payment-event field and must not be in this module`);
    assert.match(f.column, /^[a-z0-9_]+$/, `${f.column} is not snake_case`);
  }
});

// ---------------------------------------------------------------------------
// 23 Nopalito, 2026-09-21: Dossie read paragraph 6C correctly and TOLD Heath
// "seller to furnish existing survey + T-47" — but seller_provides_survey
// was false and hoa_name was null, because nothing wrote either. These tests
// prove the fix: the stored record now matches what Dossie says.
// ---------------------------------------------------------------------------

test('23 Nopalito regression: seller_provides_survey fills TRUE from an untouched (false-default) column when election (1) is extracted', () => {
  const plan = planContractTermWrites({
    tx: { seller_provides_survey: false, survey_payer: null }, // the DB default, never touched
    extracted: {
      sellerProvidesSurvey: true, // deterministically derived — election (1) was checked
      surveyPayer: "(1) Within 14 days after the Effective Date of this contract, Seller shall furnish to Buyer and Title Company Seller's existing survey of the Property and a Residential Real Property Affidavit",
    },
    documentTypeConfidence: 1,
    source: SOURCE,
  });
  assert.equal(plan.updates.seller_provides_survey, true);
  assert.match(plan.updates.survey_payer, /Seller shall furnish/);
  assert.equal(plan.conflicts.length, 0);
});

test('23 Nopalito regression: hoa_name, hoa_phone, hoa_management_company all fill from a blank dossier', () => {
  const plan = planContractTermWrites({
    tx: { hoa_name: null, hoa_phone: null, hoa_management_company: null },
    extracted: {
      hoaName: 'Sendero Ranch Owners Association',
      hoaPhone: '210-555-0100',
      hoaManagementCompany: 'Graham Management',
    },
    documentTypeConfidence: 1,
    source: SOURCE,
  });
  assert.equal(plan.updates.hoa_name, 'Sendero Ranch Owners Association');
  assert.equal(plan.updates.hoa_phone, '210-555-0100');
  assert.equal(plan.updates.hoa_management_company, 'Graham Management');
});

// Prove the guard actually fires, not just that it stays quiet: without
// treatFalseAsBlank, this exact scenario (re-run with the flag stripped,
// see below) wrongly treats the untouched false default as a real answer
// and swallows a true correction with neither a write nor a conflict record
// — the silent-drop bug class, not merely the wrong value.
test('seller_provides_survey: if a LATER re-scan disagrees with an ALREADY-CONFIRMED true, that is a conflict, not a silent overwrite', () => {
  const plan = planContractTermWrites({
    tx: { seller_provides_survey: true }, // some prior scan already correctly set this
    extracted: { sellerProvidesSurvey: false }, // a later re-scan disagrees (e.g. a revised contract)
    documentTypeConfidence: 1,
    source: SOURCE,
  });
  assert.equal(plan.updates.seller_provides_survey, undefined, 'must not silently flip an already-confirmed election');
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].column, 'seller_provides_survey');
  assert.equal(plan.conflicts[0].existing, 'true');
  assert.equal(plan.conflicts[0].parsed, 'false');
});

test('field inventory audit: every field scan-contract.js hands off that has a known transactions column either lands in TERM_FIELD_MAP or is explicitly excluded with a reason', () => {
  // Reference set: the SAME flat, transaction-column-shaped fields
  // dossie-app.jsx's own directMap objects (the general-upload path) write —
  // that IS this codebase's existing definition of "this extracted field is
  // a real column," established before this module existed. Fields here
  // that ARE in TERM_FIELD_MAP need no entry below; fields that are
  // deliberately NOT this module's job (contact-persistence.js's territory,
  // or genuinely unmapped) must be named with a reason, so a field
  // silently landing in neither list fails this test instead of vanishing —
  // exactly the 23 Nopalito bug class.
  const DIRECT_MAP_REFERENCE_FIELDS = [
    'lenderName', 'loanOfficerName', 'loanOfficerEmail', 'loanOfficerPhone',
    'buyerName', 'sellerName', 'buyer2Name', 'seller2Name', 'sellerEmail', 'sellerPhone',
    'propertyAddress', 'cityStateZip',
    'hoaName', 'hoaPhone', 'hoaManagementCompany',
    'titleCompany', 'titleOfficerName', 'titleOfficerEmail', 'titleOfficerPhone',
    'closingDate', 'commissionRate', 'possessionDate',
    'surveyDeadline', 'loanApprovalDeadline', 'appraisalDeadline', 'hoaDocumentDeadline',
    'optionExpirationDate', 'listPrice', 'listingStartDate',
    // Named explicitly by the coordinator alongside hoaName as fields Dossie
    // recites but must persist — not part of either directMap (nothing there
    // writes them either, confirmed by grep), added here as the third
    // "known extracted, must land somewhere" field.
    'surveyPayer', 'sellerProvidesSurvey',
  ];

  // Fields intentionally NOT in this module's TERM_FIELD_MAP, with why.
  const INTENTIONALLY_EXCLUDED = new Set([
    // contact-persistence.js's territory (its own K_CONFLICTS ledger, its
    // own Rule 1 pass) — this module mirrors it, does not duplicate it.
    'lenderName', 'loanOfficerName', 'loanOfficerEmail', 'loanOfficerPhone',
    'buyerName', 'sellerName', 'buyer2Name', 'seller2Name', 'sellerEmail', 'sellerPhone',
    'propertyAddress', 'cityStateZip',
  ]);

  const mappedSourceExpressions = TERM_FIELD_MAP.map((f) => f.get.toString());
  const isMapped = (fieldName) => mappedSourceExpressions.some((src) => src.includes(`.${fieldName}`));

  const unaccounted = DIRECT_MAP_REFERENCE_FIELDS.filter(
    (name) => !INTENTIONALLY_EXCLUDED.has(name) && !isMapped(name),
  );
  assert.deepEqual(unaccounted, [], `these extracted fields land nowhere and aren't explicitly excluded: ${unaccounted.join(', ')}`);
});

test('multiple independent fields on one contract: fills the blanks, conflicts the mismatches, leaves matches alone', () => {
  const plan = planContractTermWrites({
    tx: {
      closing_date: null, // blank -> fill
      sale_price: 950000, // conflict
      earnest_money: 10000, // matches
      option_fee: null, // blank -> fill
    },
    extracted: {
      closingDate: '2026-10-22',
      salePrice: 999000,
      earnestMoney: 10000,
      optionFee: 250,
    },
    documentTypeConfidence: 1,
    source: SOURCE,
  });
  assert.deepEqual(Object.keys(plan.updates).sort(), ['closing_date', 'option_fee']);
  assert.equal(plan.filled.length, 2);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].column, 'sale_price');
});
