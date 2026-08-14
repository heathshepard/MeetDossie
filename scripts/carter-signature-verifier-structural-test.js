#!/usr/bin/env node
// Structural-layer test for api/_lib/signature-verifier.js.
//
// Runs offline (no ANTHROPIC_API_KEY needed) and proves the two things the
// structural layer must get right:
//   1. It NEVER throws on the real executed Authentisign PDF, which pdf-lib
//      cannot load at all.
//   2. looksLikeEmptyFormFailure() fires on the DocuSeal-style
//      "completed but every field is blank" document.
//
// Also generates the blank-fields fixture used by the end-to-end failure-case
// test, at .tmp/esign-verify-fixtures/completed-but-blank.pdf
//
// Usage: node scripts/carter-signature-verifier-structural-test.js

'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const {
  analyzePdfStructureAsync,
  looksLikeEmptyFormFailure,
} = require('../api/_lib/signature-verifier');

const FIXTURE_DIR = path.join(__dirname, '..', '.tmp', 'esign-verify-fixtures');

// Reproduce the DocuSeal failure: a real AcroForm with signature + text fields
// where the provider reported "completed" and wrote nothing into any of them.
async function buildCompletedButBlankPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  page.drawText('AMENDMENT TO CONTRACT OF SALE', { x: 130, y: 730, size: 14, font: bold });
  page.drawText('104 Wild Cherry Ln, Boerne, TX 78006', { x: 150, y: 706, size: 11, font });
  page.drawText('Seller agrees to complete the repairs listed and credit $500 at closing.', {
    x: 60, y: 660, size: 10, font,
  });
  page.drawText('EXECUTED the ______ day of ______________, 2026.', { x: 60, y: 620, size: 10, font });

  const form = doc.getForm();
  const rows = [
    ['seller1_signature', 'Seller Signature:', 540],
    ['seller1_name', 'Printed Name:', 505],
    ['seller1_date', 'Date:', 470],
    ['seller2_signature', 'Seller Signature:', 420],
    ['seller2_name', 'Printed Name:', 385],
    ['seller2_date', 'Date:', 350],
  ];
  for (const [name, label, y] of rows) {
    page.drawText(label, { x: 60, y: y + 4, size: 9, font });
    const tf = form.createTextField(name);
    tf.addToPage(page, { x: 170, y, width: 300, height: 18 });
    // Deliberately never call tf.setText() — this is the whole point.
  }

  return Buffer.from(await doc.save());
}

function line(label, value) {
  console.log(`   ${label.padEnd(30)} ${value}`);
}

async function report(name, buffer) {
  console.log(`\n--- ${name} (${buffer.length} bytes) ---`);
  let s;
  try {
    s = await analyzePdfStructureAsync(buffer);
  } catch (err) {
    console.log(`   *** THREW — this is a hard failure: ${err.message}`);
    return { threw: true };
  }
  line('pdf-lib parseable', s.parseable + (s.parseError ? `  (${s.parseError.slice(0, 60)}...)` : ''));
  line('page count', s.pageCount);
  line('crypto signature (PKCS#7)', `${s.cryptoSignature.present}  byteRanges=${s.cryptoSignature.byteRanges} pkcs7=${s.cryptoSignature.pkcs7}`);
  line('acroform readable', s.acroForm.readable);
  line('fields total/filled/empty', `${s.acroForm.fieldCount}/${s.acroForm.filledCount}/${s.acroForm.emptyCount}`);
  line('widget annotations', s.widgetAnnotations);
  line('image xobjects', s.imageXObjects);
  line('provider hints', s.providerHints.join(', ') || '(none)');
  line('EMPTY-FORM FAILURE FLAG', looksLikeEmptyFormFailure(s) ? 'YES — would be flagged' : 'no');
  return { threw: false, structural: s, emptyFormFlag: looksLikeEmptyFormFailure(s) };
}

(async () => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const results = {};

  // 1. Real executed Authentisign PDF (if present locally).
  const real = path.join(__dirname, '..', '.tmp', 'wildcherry-amendment', 'Amendment #1 - 526.pdf');
  if (fs.existsSync(real)) {
    results.real = await report('REAL executed Authentisign amendment', fs.readFileSync(real));
  } else {
    console.log('\n--- REAL executed Authentisign amendment: not present locally, skipped ---');
  }

  // 2. The DocuSeal-style completed-but-blank failure case.
  const blank = await buildCompletedButBlankPdf();
  const blankPath = path.join(FIXTURE_DIR, 'completed-but-blank.pdf');
  fs.writeFileSync(blankPath, blank);
  results.blank = await report('SYNTHETIC completed-but-blank (DocuSeal failure)', blank);
  console.log(`\n   fixture written: ${blankPath}`);

  // --- assertions
  console.log('\n===== ASSERTIONS =====');
  let pass = true;
  const assert = (cond, msg) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
    if (!cond) pass = false;
  };

  if (results.real) {
    assert(!results.real.threw, 'structural analysis does not throw on the real Authentisign PDF');
    assert(
      results.real.structural.cryptoSignature.present,
      'real executed PDF is detected as carrying a PKCS#7 crypto signature',
    );
    assert(
      !results.real.emptyFormFlag,
      'real executed PDF is NOT flagged as an empty-form failure',
    );
  }
  assert(!results.blank.threw, 'structural analysis does not throw on the blank-fields PDF');
  assert(results.blank.emptyFormFlag, 'completed-but-blank PDF IS flagged as an empty-form failure');
  assert(
    !results.blank.structural.cryptoSignature.present,
    'blank PDF carries no crypto signature',
  );

  console.log(`\n${pass ? 'ALL STRUCTURAL TESTS PASSED' : 'STRUCTURAL TESTS FAILED'}`);
  process.exit(pass ? 0 : 1);
})();
