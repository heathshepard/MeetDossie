#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-02 CARTER fixes to
 * fillUnimprovedProperty() (TREC 9-17) in api/fill-form.js.
 *
 * Root cause (Bug 1a — the headline bug): TREC 9-17 page 1 reads "...contract
 * are ___ (Seller) and ___ (Buyer)" — Seller's blank comes FIRST — but the
 * handler wrote buyer_name into the first blank ("1 PARTIES The parties to
 * this contract are") and seller_name into the second ("and"). Every
 * unimproved-property contract Dossie generated had the parties reversed.
 * Confirmed against .tmp/coord-overlays/role-maps/unimproved-property.json
 * fields 1-2, which were position-verified from the rendered page image.
 *
 * Also covers three more name-vs-position traps found in the same mapping
 * pass and fixed in the same commit:
 *   Bug 1b — page-2 title-policy (¶6A) expense checkboxes: the AcroForm field
 *     literally named "Buyer" sits before the PRINTED word "Seller's", and
 *     the field named "Seller" sits before printed "Buyer's". The handler
 *     had them backwards.
 *   Bug 1c — checkboxes named "is no. 1" / "is not 2" were wired as a
 *     mineral-rights pair (fv.mineral_rights_excluded_1/_2) but are actually
 *     the page-4 ¶6E(8) Texas Agricultural Development District pair.
 *
 * Fills the real blank TREC 9-17 asset via the production fillForm()
 * dispatcher (module.exports.__testing), reloads the saved (non-flattened)
 * PDF, and reads the AcroForm fields straight back — this is a direct
 * text/checkbox readback against the exact field names the role map
 * position-verified, not a mere "does the value exist somewhere" check.
 *
 * Run manually:
 *   node scripts/regression-unimproved-property-field-swaps.js
 */

const assert = require('assert');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const REPO = path.join(__dirname, '..');
const { fillForm } = require(path.join(REPO, 'api/fill-form.js')).__testing;

const SELLER_SENTINEL = 'SELLER TEST NAME';
const BUYER_SENTINEL = 'BUYER TEST NAME';

async function fillAndLoad(fv) {
  const bytes = await fillForm('unimproved-property', fv);
  return PDFDocument.load(bytes);
}

async function testPartyNamesLandInCorrectBlanks() {
  const doc = await fillAndLoad({ seller_name: SELLER_SENTINEL, buyer_name: BUYER_SENTINEL });
  const form = doc.getForm();
  const firstBlank = form.getTextField('1 PARTIES The parties to this contract are').getText();
  const secondBlank = form.getTextField('and').getText();
  assert.strictEqual(
    firstBlank, SELLER_SENTINEL,
    `printed "...contract are ___ (Seller)" blank should hold "${SELLER_SENTINEL}", got "${firstBlank}"`
  );
  assert.strictEqual(
    secondBlank, BUYER_SENTINEL,
    `printed "and ___ (Buyer)" blank should hold "${BUYER_SENTINEL}", got "${secondBlank}"`
  );
  console.log('  PASS: seller_name -> first blank (Seller), buyer_name -> second blank (Buyer)');
}

async function testTitlePolicyExpenseCheckboxesNotSwapped() {
  // Default (buyer_pays_survey falsy) -> Seller pays -> field named "Buyer"
  // (which sits before printed "Seller's") should be checked.
  const docDefault = await fillAndLoad({ seller_name: SELLER_SENTINEL, buyer_name: BUYER_SENTINEL });
  const formDefault = docDefault.getForm();
  assert.strictEqual(
    formDefault.getCheckBox('Buyer').isChecked(), true,
    'default (seller pays title policy) should check the field NAMED "Buyer" (it sits before printed "Seller\'s")'
  );
  assert.strictEqual(
    formDefault.getCheckBox('Seller').isChecked(), false,
    'default (seller pays) should leave the field NAMED "Seller" unchecked'
  );

  // buyer_pays_survey === true -> Buyer pays -> field named "Seller" (sits
  // before printed "Buyer's") should be checked instead.
  const docBuyerPays = await fillAndLoad({ seller_name: SELLER_SENTINEL, buyer_name: BUYER_SENTINEL, buyer_pays_survey: true });
  const formBuyerPays = docBuyerPays.getForm();
  assert.strictEqual(
    formBuyerPays.getCheckBox('Seller').isChecked(), true,
    'buyer_pays_survey=true should check the field NAMED "Seller" (it sits before printed "Buyer\'s")'
  );
  assert.strictEqual(
    formBuyerPays.getCheckBox('Buyer').isChecked(), false,
    'buyer_pays_survey=true should leave the field NAMED "Buyer" unchecked'
  );
  console.log('  PASS: title-policy expense checkboxes land on the printed-position-correct field, not the AcroForm name');
}

async function testAgDevelopmentDistrictNotMineralRights() {
  const doc = await fillAndLoad({
    seller_name: SELLER_SENTINEL,
    buyer_name: BUYER_SENTINEL,
    ag_development_district_is_selected: true,
  });
  const form = doc.getForm();
  assert.strictEqual(
    form.getCheckBox('is no. 1').isChecked(), true,
    'ag_development_district_is_selected should check "is no. 1" (page-4 6E(8) Ag Development District pair)'
  );
  assert.strictEqual(
    form.getCheckBox('is not 2').isChecked(), false,
    '"is not 2" should stay unchecked when only the IS option is selected'
  );

  const docNot = await fillAndLoad({
    seller_name: SELLER_SENTINEL,
    buyer_name: BUYER_SENTINEL,
    ag_development_district_is_not_selected: true,
  });
  const formNot = docNot.getForm();
  assert.strictEqual(formNot.getCheckBox('is not 2').isChecked(), true, 'ag_development_district_is_not_selected should check "is not 2"');
  console.log('  PASS: "is no. 1" / "is not 2" wired to the Ag Development District pair, not a nonexistent mineral-rights field');
}

async function main() {
  console.log('TREC 9-17 (Unimproved Property Contract) regression — 2026-09-02 field-swap fixes');
  console.log('====================================================================================');
  const tests = [
    ['party names land in printed-position-correct blanks (Seller first, Buyer second)', testPartyNamesLandInCorrectBlanks],
    ['page-2 title-policy (6A) expense checkboxes not swapped', testTitlePolicyExpenseCheckboxesNotSwapped],
    ['"is no. 1"/"is not 2" wired to Ag Development District, not mineral rights', testAgDevelopmentDistrictNotMineralRights],
  ];
  let failed = 0;
  for (const [label, fn] of tests) {
    try {
      console.log('\n' + label);
      await fn();
    } catch (e) {
      failed++;
      console.error('  FAIL:', e && e.message);
    }
  }
  console.log('\n====================================================================================');
  if (failed) {
    console.log(failed + ' test(s) FAILED');
    process.exit(1);
  }
  console.log('All tests passed');
}

main().catch((e) => {
  console.error('FATAL:', e && e.stack || e);
  process.exit(1);
});
