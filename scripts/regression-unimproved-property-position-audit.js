#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-01 CARTER full position audit of
 * fillUnimprovedProperty() (TREC 9-17) — Quinn QA Bugs 4 + 5 plus the
 * follow-on audit of every field mapping in the function.
 *
 * The 9-17 asset's AcroForm field NAMES are recycled garbage that often sit
 * nowhere near the printed label the name suggests. Confirmed via the
 * widget-rectangle overlay renders (.tmp/coord-overlays/unimproved-property-
 * page-*.png — numbered boxes drawn at each widget's getRectangle()
 * position). 16 mappings were wrong, including:
 *   - Bug 4: sale_price was written to 'undefined_4' (the §5.A escrow-agent
 *     ADDRESS line); §3.A/B/C rendered completely blank. 'undefined' /
 *     'undefined_2' / 'undefined_3' are the real §3.A cash / §3.B financing
 *     / §3.C total blanks.
 *   - Bug 5: option_fee was written to 'Option Fee in the form of' (the
 *     page-10 receipt PAYMENT-METHOD slot). The §5.A Option Fee amount is
 *     'undefined_5'.
 *   - '4 days' is the §5.B OPTION PERIOD days blank; option days were never
 *     printed anywhere (a checklist-critical field).
 *   - 'i will not be amended...' is §4.B(1) "Seller has delivered copies of
 *     all Natural Resource Leases" — and the old code CHECKED IT BY DEFAULT
 *     on every fill.
 *   - 'Email'/'Email_2' are the §23 attorney e-mail lines, not the parties'.
 *   - 'Buyer must object the earlier of...' is the §6.D day-count blank.
 *
 * Verifies by filling the real asset via fillForm() and reading values back
 * off the named AcroForm fields (positions proven by the overlay renders),
 * plus a pdftotext render assertion for §3.
 *
 * Run manually:
 *   node scripts/regression-unimproved-property-position-audit.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'stub-key';

const REPO = path.join(__dirname, '..');
const { fillForm } = require(path.join(REPO, 'api/fill-form.js')).__testing;

const FV = {
  seller_name: 'Fixture Seller',
  buyer_name: 'Fixture Buyer',
  property_address: '9042 QA Test Parcel',
  city_state_zip: 'Boerne, TX 78006',
  county: 'Kendall',
  sale_price: '180000',
  loan_amount: '144000',
  earnest_money: '1800',
  option_fee: '250',
  option_days: '7',
  title_company: 'QA Title Co',
  escrow_agent_address: '100 Escrow St, Boerne, TX',
  closing_date: '2026-10-15',
  contract_effective_date: '2026-09-01',
  land_acreage: '5.2',
  title_objection_days: '10',
  buyer_email: 'buyer@example.test',
  seller_email: 'seller@example.test',
  survey_option: '1',
  survey_days_seller: '9',
};

let doc;
let form;
let pdfBytes;

function text(name) {
  try { return form.getTextField(name).getText() || ''; } catch (_e) { return `<missing field ${name}>`; }
}
function checked(name) {
  try { return form.getCheckBox(name).isChecked(); } catch (_e) { return `<missing field ${name}>`; }
}

const CASES = [
  // [description, fn]
  ['§3.C total sales price lands on undefined_3', () =>
    assert.strictEqual(text('undefined_3'), '180,000', `undefined_3 (§3.C Sales Price) holds "${text('undefined_3')}"`)],
  ['§3.B financing sum lands on undefined_2', () =>
    assert.strictEqual(text('undefined_2'), '144,000', `undefined_2 (§3.B financing) holds "${text('undefined_2')}"`)],
  ['§3.A cash portion computed onto undefined', () =>
    assert.strictEqual(text('undefined'), '36,000', `undefined (§3.A cash portion) holds "${text('undefined')}"`)],
  ['sale price does NOT leak onto the §5.A escrow address line (undefined_4)', () =>
    assert.strictEqual(text('undefined_4'), '', `undefined_4 (§5.A address line 2) holds "${text('undefined_4')}" — Bug 4 regressed`)],
  ['§5.A option fee amount lands on undefined_5', () =>
    assert.strictEqual(text('undefined_5'), '250', `undefined_5 (§5.A Option Fee) holds "${text('undefined_5')}"`)],
  ['option fee amount does NOT land on the receipt payment-method slot', () =>
    assert.strictEqual(text('Option Fee in the form of'), '', `receipt "in the form of" holds "${text('Option Fee in the form of')}" — Bug 5 regressed`)],
  ['§5.B option period days land on the field named "4 days"', () =>
    assert.strictEqual(text('4 days'), '7', `'4 days' (§5.B Option Period) holds "${text('4 days')}"`)],
  ['§4.B(1) lease-delivery box is NOT checked by default', () =>
    assert.strictEqual(checked('i will not be amended or deleted from the title policy or'), false,
      '§4.B(1) "Seller has delivered all Natural Resource Leases" was checked without any input — silent legal attestation')],
  ['§6.D objection days land on the page-3 day-count blank', () =>
    assert.strictEqual(text('Buyer must object the earlier of i the Closing Date or ii'), '10',
      `§6.D days blank holds "${text('Buyer must object the earlier of i the Closing Date or ii')}"`)],
  ['buyer email goes to §21 notices (Text6), not the §23 attorney line (Email)', () => {
    assert.strictEqual(text('Text6'), 'buyer@example.test', `Text6 (§21 Buyer E-mail) holds "${text('Text6')}"`);
    assert.strictEqual(text('Email'), '', `Email (§23 Buyer's Attorney e-mail) holds "${text('Email')}"`);
  }],
  ['§6.C survey option 1 + days land on the page-2 survey fields', () => {
    assert.strictEqual(checked('1 Within'), true, '§6.C(1) checkbox not checked');
    assert.strictEqual(text('Title Company Sellers existing survey of the Property and a Residential Real Property Affidavit'), '9',
      '§6.C(1) day blank wrong');
  }],
  ['page-10 receipts carry amounts on the "is acknowledged" $ blanks', () => {
    assert.strictEqual(text('is acknowledged'), '250', `option-fee receipt $ holds "${text('is acknowledged')}"`);
    assert.strictEqual(text('is acknowledged_2'), '1,800', `earnest receipt $ holds "${text('is acknowledged_2')}"`);
  }],
  ['rendered page 1 carries all three §3 figures', () => {
    const tmp = path.join(os.tmpdir(), 'regression-917-' + Date.now() + '.pdf');
    fs.writeFileSync(tmp, pdfBytes);
    let p1;
    try { p1 = execSync(`pdftotext -f 1 -l 1 "${tmp}" -`).toString(); } finally { fs.unlinkSync(tmp); }
    assert.ok(p1.includes('36,000'), 'cash portion 36,000 missing from rendered page 1');
    assert.ok(p1.includes('144,000'), 'financing 144,000 missing from rendered page 1');
    assert.ok(p1.includes('180,000'), 'total 180,000 missing from rendered page 1');
  }],
];

async function main() {
  console.log('TREC 9-17 position-audit regression — 2026-09-01 (Quinn Bugs 4/5 + full field audit)');
  console.log('=========================================================================================');
  pdfBytes = Buffer.from(await fillForm('unimproved-property', FV));
  doc = await PDFDocument.load(pdfBytes);
  form = doc.getForm();

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
