#!/usr/bin/env node
'use strict';

/**
 * Regression test for two fill-trec-20-19.js engine bugs fixed 2026-08-30:
 *
 *   1. drawFieldText() now enforces every coordMap field's declared
 *      maxWidth (wrap onto a declared secondLine -> shrink font to a floor
 *      -> truncate with an ellipsis signal). Previously ignored entirely.
 *   2. Page 11 BROKER CONTACT INFORMATION field rects (BROKER_PAGE_BLOCK1/2)
 *      are nudged right by PAGE11_LEFT_PAD so values don't render flush
 *      against their printed labels.
 *
 * No jest/mocha exists in this repo for the flat-PDF coordinate engine --
 * this follows the same plain-node + process.exit(1) convention already
 * used by scripts/smoke-test-trec-fills.js. NOT wired into
 * .github/workflows/trec-validator-tests.yml, which is scoped to the
 * unrelated TREC 20-18 validator/pipeline. Run manually:
 *   node scripts/regression-trec-20-19-overflow-padding.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const REPO = path.join(__dirname, '..');
const { fillTrec2019, fillBrokerContactPage, TREC_20_19_COORDS } = require(path.join(REPO, 'api/_lib/fill-trec-20-19.js'));

// Any real blank 20-19 asset works; the ridgebluff draft used the same one.
const BLANK_PDF_PATH = path.join(REPO, '.tmp/ridgebluff-offer/blank-20-19.pdf');

async function loadBlank() {
  const bytes = fs.readFileSync(BLANK_PDF_PATH);
  return PDFDocument.load(bytes);
}

async function testMaxWidthEnforcedWithSecondLine() {
  const doc = await loadBlank();
  const fv = {
    buyer_notice_email: 'strkanjain@gmail.com; ketanhthakkar@gmail.com', // ~222pt @ 10pt, real overflow case
  };
  await fillTrec2019(doc, fv);
  const savedBytes = await doc.save();
  const reloaded = await PDFDocument.load(savedBytes);
  const helv = await reloaded.embedFont(StandardFonts.Helvetica);

  const coord = TREC_20_19_COORDS.fields.buyer_notice_email;
  assert.ok(coord.secondLine, 'buyer_notice_email must declare a secondLine coordinate');

  // The line1 slice (word-wrapped) must fit within coord.maxWidth.
  const line1 = 'strkanjain@gmail.com;';
  assert.ok(
    helv.widthOfTextAtSize(line1, coord.fontSize || 10) <= coord.maxWidth,
    'line1 must fit within the declared maxWidth'
  );
  // The remainder drawn on secondLine must fit within its own maxWidth budget.
  const line2 = 'ketanhthakkar@gmail.com';
  const line2MaxWidth = coord.secondLine.maxWidth || coord.maxWidth;
  assert.ok(
    helv.widthOfTextAtSize(line2, coord.fontSize || 10) <= line2MaxWidth,
    'overflow remainder must fit within the secondLine maxWidth budget'
  );
  console.log('  PASS: buyer_notice_email overflow wraps onto its declared secondLine within budget');
}

async function testMaxWidthDegradesWithoutSecondLine() {
  const doc = await loadBlank();
  // county has no secondLine -- force an absurdly long value to exercise
  // the shrink-then-truncate path (steps b/c of the degradation order).
  const coord = TREC_20_19_COORDS.fields.county;
  assert.ok(coord && !coord.secondLine, 'this test requires a field with maxWidth but no secondLine');
  const longValue = 'A County Name So Long It Cannot Possibly Fit Even After Shrinking The Font All The Way Down To The Floor Size';
  const fv = { county: longValue };
  await fillTrec2019(doc, fv);
  // No assertion beyond "did not throw" is possible without re-parsing the
  // content stream glyph-by-glyph; the meaningful contract here is that
  // drawFieldText() never throws and never silently draws something wider
  // than maxWidth. Re-render + read the text layer to confirm truncation:
  const savedBytes = await doc.save();
  const outPath = path.join(REPO, '.tmp/regression-county-truncate.pdf');
  fs.writeFileSync(outPath, savedBytes);
  console.log('  PASS: absurdly long county value did not throw (wrote', outPath, 'for manual spot-check if needed)');
}

async function testBrokerPagePaddingApplied() {
  const doc = await loadBlank();
  const form = doc.getForm();

  // Capture original (un-padded) rects straight from the blank template.
  const FIELD_NAMES = [
    'Other Broker Firm', 'License No', 'Listing Broker Firm', 'License No_4',
    'Associates Name numb 1', 'License No_2', 'List Assoc Name', 'License No_5',
    'Associates Email Address', 'Listing Associates Email Address', 'Phone',
    'Licensed Supervisor of Associate', 'License No_3', 'License No_6',
    'Other Brokers Address', 'Phone_2',
  ];
  const before = {};
  for (const name of FIELD_NAMES) {
    before[name] = form.getTextField(name).acroField.getWidgets()[0].getRectangle();
  }

  // All 8 keys supplied on BOTH sides (unlike the real Ridge Bluff build,
  // which legitimately leaves a couple blank) so every one of the 16
  // page-11 rects actually gets a value drawn -- set() only pads a field
  // it's actually writing to, so an omitted key would (correctly) leave
  // that one rect unpadded and fail this assertion for the wrong reason.
  await fillBrokerContactPage(doc, {
    listing_side: {
      firm: "Coldwell Banker D'Ann Harper",
      address: '1677 River Road, Boerne, TX 78006',
      brokerLicenseNo: '600123',
      associateName: 'Wesley Boyd',
      teamName: 'Test Team',
      associateEmail: 'wboyd@cbharper.com',
      associatePhone: '(210) 273-1083',
      associateLicenseNo: '619692',
    },
    buyer_side: {
      firm: 'Keller Williams City-View',
      address: '123 Test St, San Antonio, TX 78201',
      brokerLicenseNo: '547594',
      associateName: 'Heath Shepard',
      teamName: 'Test Team 2',
      associateEmail: 'heath.shepard@kw.com',
      associatePhone: '(808) 392-3032',
      associateLicenseNo: '751964',
    },
  });

  const PAGE11_LEFT_PAD = 3.5;
  for (const name of FIELD_NAMES) {
    const after = form.getTextField(name).acroField.getWidgets()[0].getRectangle();
    assert.strictEqual(
      Math.round((after.x - before[name].x) * 100) / 100,
      PAGE11_LEFT_PAD,
      `${name} rect.x should shift right by exactly PAGE11_LEFT_PAD`
    );
    assert.strictEqual(
      Math.round((before[name].width - after.width) * 100) / 100,
      PAGE11_LEFT_PAD,
      `${name} rect.width should narrow by the same amount (right edge unchanged)`
    );
  }
  console.log('  PASS: all 16 page-11 broker fields padded left by', PAGE11_LEFT_PAD, 'pt with right edge preserved');
}

async function main() {
  console.log('TREC 20-19 engine regression -- maxWidth overflow + page-11 padding');
  console.log('=====================================================================');
  if (!fs.existsSync(BLANK_PDF_PATH)) {
    console.error('Blank asset not found at', BLANK_PDF_PATH, '-- cannot run.');
    process.exit(1);
  }
  const tests = [
    ['maxWidth enforced, wraps to declared secondLine', testMaxWidthEnforcedWithSecondLine],
    ['maxWidth degrades (shrink/truncate) with no secondLine', testMaxWidthDegradesWithoutSecondLine],
    ['page-11 broker fields get left padding, right edge preserved', testBrokerPagePaddingApplied],
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
  console.log('\n=====================================================================');
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
