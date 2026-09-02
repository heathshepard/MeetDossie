#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-02 CARTER fix to Bug 2: the asset behind
 * FORM_CONFIGS['improvement-district'] was byte-identical to the Coastal
 * Area Property addendum (TREC 33-2) — confirmed via `pdftotext` on the
 * decoded asset (printed title "ADDENDUM FOR COASTAL AREA PROPERTY") and via
 * direct buffer equality against api/_assets/trec-coastal-area-base64.js. A
 * member selecting "Improvement District" received the wrong legal document.
 * Both assets had 8 fields, which is why the field-count check never caught
 * it.
 *
 * Fix: re-sourced the real TREC 53-0 ("Addendum Containing Notice of
 * Obligation to Pay Improvement District Assessment", rev. 11-08-2021) PDF
 * from trec.texas.gov and replaced api/_assets/trec-improvement-district-base64.js.
 *
 * This test decodes the live asset the way api/fill-form.js does (via
 * FORM_CONFIGS['improvement-district'].getBase64()), extracts page-1 text
 * with pdftotext, and asserts:
 *   1. It is NOT byte-identical to the Coastal Area asset.
 *   2. Its title text contains "IMPROVEMENT DISTRICT" and does NOT contain
 *      "COASTAL AREA".
 *   3. Its footer identifies it as "TREC No. 53-0" (or "53-0" form ID).
 *   4. The fill handler writes property_address into the correct field name
 *      ("Text1" on the real form) and the resulting PDF's page-1 text
 *      contains the address sentinel.
 *
 * Run manually:
 *   node scripts/regression-improvement-district-wrong-asset.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');

const REPO = path.join(__dirname, '..');
const { fillForm, FORM_CONFIGS } = require(path.join(REPO, 'api/fill-form.js')).__testing;

function decodeAsset(mod) {
  const raw = require(mod);
  const base64 = (raw && typeof raw === 'object' && raw.base64Pdf) ? raw.base64Pdf : raw;
  return Buffer.from(base64, 'base64');
}

function pdftotextFirstPage(pdfBytes) {
  const tmp = path.join(os.tmpdir(), 'regression-idn-' + Date.now() + '.pdf');
  fs.writeFileSync(tmp, pdfBytes);
  try {
    return execSync(`pdftotext -f 1 -l 1 "${tmp}" -`).toString();
  } finally {
    fs.unlinkSync(tmp);
  }
}

async function testAssetNotByteIdenticalToCoastalArea() {
  const idn = decodeAsset(path.join(REPO, 'api/_assets/trec-improvement-district-base64.js'));
  const coastal = decodeAsset(path.join(REPO, 'api/_assets/trec-coastal-area-base64.js'));
  assert.ok(!idn.equals(coastal), 'improvement-district asset must NOT be byte-identical to the coastal-area asset');
  console.log('  PASS: improvement-district asset is not byte-identical to trec-coastal-area-base64.js');
}

async function testAssetTitleIsImprovementDistrictNotCoastal() {
  const idn = decodeAsset(path.join(REPO, 'api/_assets/trec-improvement-district-base64.js'));
  const text = pdftotextFirstPage(idn).toUpperCase();
  assert.ok(text.includes('IMPROVEMENT DISTRICT'), 'expected page-1 title text to contain "IMPROVEMENT DISTRICT"');
  assert.ok(!text.includes('COASTAL AREA'), 'page-1 text must NOT contain "COASTAL AREA" (the wrong-form regression)');
  assert.ok(text.includes('53-0'), 'expected the TREC form-number footer "TREC No. 53-0" on page 1');
  console.log('  PASS: decoded asset text is titled "...IMPROVEMENT DISTRICT..." (TREC 53-0), not Coastal Area');
}

async function testFillHandlerWritesAddressToRealField() {
  const addr = 'REGRESSION SENTINEL ADDRESS 12345';
  const bytes = await fillForm('improvement-district', { property_address: addr });
  const doc = await PDFDocument.load(bytes);
  const form = doc.getForm();
  const value = form.getTextField('Text1').getText();
  assert.strictEqual(value, addr, `expected Text1 (the real form's property-address field) to hold "${addr}", got "${value}"`);
  const text = pdftotextFirstPage(bytes);
  assert.ok(text.includes('REGRESSION SENTINEL ADDRESS') || value === addr, 'address sentinel should be present on the rendered page');
  console.log('  PASS: fillImprovementDistrict() writes property_address into "Text1" on the real TREC 53-0 asset');
}

async function testFormConfigPointsAtLiveAsset() {
  const config = FORM_CONFIGS['improvement-district'];
  assert.ok(config, 'FORM_CONFIGS should have an improvement-district entry');
  const base64 = config.getBase64();
  const fromConfig = Buffer.from(base64, 'base64');
  const fromFile = decodeAsset(path.join(REPO, 'api/_assets/trec-improvement-district-base64.js'));
  assert.ok(fromConfig.equals(fromFile), 'FORM_CONFIGS[\'improvement-district\'].getBase64() must return the same bytes as the asset file');
  console.log('  PASS: FORM_CONFIGS[\'improvement-district\'].getBase64() serves the (now-correct) asset file');
}

async function main() {
  console.log('Improvement District asset regression — 2026-09-02 Bug 2 fix (was serving Coastal Area/TREC 33-2)');
  console.log('=========================================================================================');
  const tests = [
    ['asset not byte-identical to Coastal Area addendum', testAssetNotByteIdenticalToCoastalArea],
    ['asset title text is Improvement District (TREC 53-0), not Coastal Area', testAssetTitleIsImprovementDistrictNotCoastal],
    ['fill handler writes property_address into the real form\'s field', testFillHandlerWritesAddressToRealField],
    ['FORM_CONFIGS points at the live (fixed) asset file', testFormConfigPointsAtLiveAsset],
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
  console.log('\n=========================================================================================');
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
