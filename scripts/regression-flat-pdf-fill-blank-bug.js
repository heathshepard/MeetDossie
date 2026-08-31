#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 45dbdaa0 (2026-06-16) silent-blank-PDF bug in
 * api/fill-form.js.
 *
 * Pre-fix behavior: fillTerminationNotice / fillFarmRanch /
 * fillNewHomeIncomplete / fillNewHomeComplete called safeSetText(form, name,
 * value), which looks up an AcroForm field by name and swallows (console.warn
 * only, no throw) any error -- including "field not found". The four base64
 * assets those handlers filled are flat PDFs with ZERO AcroForm fields
 * (confirmed below), so every safeSetText() call was a guaranteed no-op.
 * fill-form.js returned 200 with a completely blank PDF attached, with
 * nothing in the response distinguishing it from a real fill.
 *
 * Post-fix: those four handlers route through flat-pdf-filler's
 * coordinate-based fillFlatPdfFromMapStrict(), which draws real text onto
 * the page content stream (verifiable by independent text extraction, not
 * just "no error thrown") and THROWS if the map lookup or the draw pass
 * comes back empty.
 *
 * This suite proves the fix two ways:
 *   1. Reproduces the exact pre-fix code path (inlined, byte-for-byte
 *      equivalent to the historical safeSetText()) against the real flat PDF
 *      assets and shows it silently produces zero placed text -- i.e. this
 *      suite FAILS (the "produced a blank PDF" assertion trips) if pointed
 *      at the pre-fix routing.
 *   2. Runs the CURRENT api/fill-form.js fillForm() for all four form types
 *      and independently verifies (via pdftotext, not our own
 *      instrumentation) that the injected values actually appear in the
 *      rendered PDF text.
 *   3. Exercises fillFlatPdfFromMapStrict's loud-failure gate directly.
 *
 * Follows the plain-node + process.exit(1) convention of
 * scripts/regression-trec-20-19-esign-coords.js. Run manually:
 *   node scripts/regression-flat-pdf-fill-blank-bug.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');

const REPO = path.join(__dirname, '..');
const { fillForm, FORM_CONFIGS } = require(path.join(REPO, 'api/fill-form.js')).__testing;
const { fillFlatPdfFromMapStrict } = require(path.join(REPO, 'api/_assets/flat-pdf-filler.js'));

const TREC_38_7_MAP = require(path.join(REPO, 'api/_assets/field-maps/trec-38-7-coords.json'));
const TREC_23_20_MAP = require(path.join(REPO, 'api/_assets/field-maps/trec-23-20-coords.json'));
const TREC_24_20_MAP = require(path.join(REPO, 'api/_assets/field-maps/trec-24-20-coords.json'));
const TREC_25_17_MAP = require(path.join(REPO, 'api/_assets/field-maps/trec-25-17-coords.json'));

const FORMS = [
  {
    formType: 'termination-notice',
    label: 'Notice of Termination (TREC 38-7)',
    map: TREC_38_7_MAP,
    fv: {
      buyer_name: 'John Smith',
      seller_name: 'Jane Doe',
      property_address: '123 Main Street',
      city_state_zip: 'San Antonio, TX 78201',
      contract_effective_date: '2026-05-15',
      termination_notice_date: '2026-06-12',
    },
    expectInText: ['John Smith', 'Jane Doe'],
  },
  {
    formType: 'new-home-incomplete',
    label: 'New Home Contract - Incomplete Construction (TREC 23-20)',
    map: TREC_23_20_MAP,
    fv: {
      buyer_name: 'Robert Johnson',
      seller_name: 'New Homes Builder LLC',
      property_address: '456 Oak Drive',
      county: 'Travis',
      sale_price: '450000',
      earnest_money: '10000',
      closing_date: '2026-08-15',
    },
    expectInText: ['Robert Johnson', 'New Homes Builder LLC'],
  },
  {
    formType: 'new-home-complete',
    label: 'New Home Contract - Completed Construction (TREC 24-20)',
    map: TREC_24_20_MAP,
    fv: {
      buyer_name: 'Michael Brown',
      seller_name: 'Premier Builders Inc',
      property_address: '789 Elm Street',
      county: 'Harris',
      sale_price: '450000',
      earnest_money: '12000',
      closing_date: '2026-07-30',
    },
    expectInText: ['Michael Brown', 'Premier Builders Inc'],
  },
  {
    formType: 'farm-ranch',
    label: 'Farm and Ranch Contract (TREC 25-17)',
    map: TREC_25_17_MAP,
    fv: {
      buyer_name: 'Thomas Davis',
      seller_name: 'Ranch Properties LLC',
      county: 'Kendall',
      sale_price: '750000',
      earnest_money: '25000',
      closing_date: '2026-09-15',
    },
    expectInText: ['Thomas Davis', 'Ranch Properties LLC'],
  },
];

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-pdf-regression-'));

function pdfToText(pdfBytes) {
  const tmpPdf = path.join(TMP_DIR, `probe-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(tmpPdf, pdfBytes);
  const out = execFileSync('pdftotext', [tmpPdf, '-'], { encoding: 'utf8' });
  return out;
}

// Byte-for-byte reproduction of the pre-fix api/fill-form.js safeSetText().
function preFixSafeSetText(form, fieldName, value) {
  try {
    const field = form.getTextField(fieldName);
    field.setText(value == null ? '' : String(value));
  } catch (e) {
    // pre-fix: swallowed silently, no throw, no visible failure
  }
}

async function testAllFourAssetsAreZeroFieldFlatPdfs() {
  for (const f of FORMS) {
    const config = FORM_CONFIGS[f.formType];
    const raw = config.getBase64();
    const base64 = (raw && typeof raw === 'object' && raw.base64Pdf) ? raw.base64Pdf : raw;
    const pdfDoc = await PDFDocument.load(Buffer.from(base64, 'base64'), { ignoreEncryption: true });
    const fieldCount = pdfDoc.getForm().getFields().length;
    assert.strictEqual(fieldCount, 0, `${f.label}: expected 0 AcroForm fields (flat PDF precondition of the bug), got ${fieldCount}`);
  }
  console.log('  PASS: all 4 wired base64 assets are confirmed 0-AcroForm-field flat PDFs');
}

async function testPreFixCodePathProducesNoVisibleText() {
  for (const f of FORMS) {
    const config = FORM_CONFIGS[f.formType];
    const raw = config.getBase64();
    const base64 = (raw && typeof raw === 'object' && raw.base64Pdf) ? raw.base64Pdf : raw;
    const pdfDoc = await PDFDocument.load(Buffer.from(base64, 'base64'), { ignoreEncryption: true });
    const form = pdfDoc.getForm();

    // Exercise the OLD routing shape: safeSetText() calls keyed by guessed
    // AcroForm field names (same guessed names the pre-fix handlers used,
    // e.g. 'BUYER', '1 PARTIES The parties to this contract are').
    preFixSafeSetText(form, 'BUYER', f.fv.buyer_name);
    preFixSafeSetText(form, '1 PARTIES The parties to this contract are', f.fv.buyer_name);
    preFixSafeSetText(form, 'and', f.fv.seller_name);
    preFixSafeSetText(form, 'BETWEEN THE UNDERSIGNED SELLER AND', f.fv.seller_name);

    const pdfBytes = await pdfDoc.save();
    const text = pdfToText(pdfBytes);
    for (const needle of f.expectInText) {
      assert.ok(
        !text.includes(needle),
        `${f.label}: pre-fix safeSetText() path unexpectedly rendered "${needle}" -- ` +
        `this suite's premise (safeSetText silently no-ops on these 0-field flat PDFs) is wrong, investigate`
      );
    }
  }
  console.log('  PASS: reproduced pre-fix safeSetText() path against all 4 real assets -- confirmed it silently ships a BLANK PDF (no thrown error, no visible text) -- this is the exact 45dbdaa0 bug');
}

async function testCurrentFillFormProducesRealVisibleText() {
  for (const f of FORMS) {
    const pdfBytes = await fillForm(f.formType, f.fv);
    const text = pdfToText(pdfBytes);
    for (const needle of f.expectInText) {
      assert.ok(
        text.includes(needle),
        `${f.label}: current fillForm() output does not contain "${needle}" in extracted text -- ` +
        `the fix did not actually place visible content on the page`
      );
    }
  }
  console.log('  PASS: current fillForm() (post-fix routing) produces PDFs with the real injected values independently verifiable via pdftotext -- not just "no error thrown"');
}

async function testStrictGateBlocksEmptyOrEmptyMap() {
  // Empty/missing field map -> must throw
  const pdfDoc1 = await PDFDocument.create();
  pdfDoc1.addPage([612, 792]);
  await assert.rejects(
    () => fillFlatPdfFromMapStrict(pdfDoc1, { buyer_name: 'Test' }, { fields: {} }, 'Empty Map Test'),
    /field map is missing or empty/,
    'gate must block an empty field map'
  );

  // Supplied values that match nothing in the map -> must throw (this is the
  // exact silent-blank-PDF shape: real data, wrong/missing keys)
  const pdfDoc2 = await PDFDocument.create();
  pdfDoc2.addPage([612, 792]);
  const bogusMap = { fields: { some_other_field: { page: 1, x: 10, y: 10 } } };
  await assert.rejects(
    () => fillFlatPdfFromMapStrict(pdfDoc2, { buyer_name: 'Test', seller_name: 'Test2' }, bogusMap, 'Mismatched Keys Test'),
    /none matched a logical field name/,
    'gate must block a fv/map key mismatch (the historical failure shape)'
  );

  // Correctly matched values -> must NOT throw
  const pdfDoc3 = await PDFDocument.create();
  pdfDoc3.addPage([612, 792]);
  const goodMap = { fields: { buyer_name: { page: 1, x: 10, y: 10, font_size: 10 } } };
  await assert.doesNotReject(
    () => fillFlatPdfFromMapStrict(pdfDoc3, { buyer_name: 'Test' }, goodMap, 'Good Map Test'),
    'gate must NOT block a correctly matched fv/map pair'
  );

  console.log('  PASS: fillFlatPdfFromMapStrict blocks empty maps and fv/map key mismatches, allows correct matches');
}

async function main() {
  console.log('Flat-PDF silent-blank-fill regression (45dbdaa0 fix) -- termination-notice / new-home-incomplete / new-home-complete / farm-ranch');
  console.log('====================================================================================================================================');
  const tests = [
    ['All 4 wired assets are 0-AcroForm-field flat PDFs (bug precondition)', testAllFourAssetsAreZeroFieldFlatPdfs],
    ['Pre-fix safeSetText() code path silently ships a blank PDF (proves this suite is not a no-op)', testPreFixCodePathProducesNoVisibleText],
    ['Current fillForm() places real, independently-verifiable text', testCurrentFillFormProducesRealVisibleText],
    ['fillFlatPdfFromMapStrict loud-failure gate', testStrictGateBlocksEmptyOrEmptyMap],
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
  console.log('\n====================================================================================================================================');
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
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
