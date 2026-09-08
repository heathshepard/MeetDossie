#!/usr/bin/env node
'use strict';

/**
 * Regression test for the TREC 20-19 e-sign geometry in api/esign-create.js.
 *
 * History of the geometry this file guards:
 *
 * 2026-08-31 fix (original version of this suite): esign-create.js had been
 * loading TREC 20-18's coord map (8 initial pages 1-8, signature on page 9)
 * and applying it unchanged to the 12-page TREC 20-19 — pages of required
 * initials were silently missing from every packet, and no gate caught it.
 *
 * 2026-09-08 fix (this version): the 2026-08-31 extraction ALSO mapped
 * initials onto page 12. Page 12 (Option Fee / Earnest Money / Contract
 * Receipt — completed by the escrow agent) does NOT print an initial line:
 * its "Initialed for identification" text run exists in the content stream
 * at the same x/y as pages 1-9 but is never painted (invisible text), so
 * pdftotext reports a false positive while the rendered page — and the live
 * DocuSeal signing page, where Quinn caught it — shows the widgets floating
 * on blank margin. The real initial-bearing pages are exactly 1-9.
 * Page 10 is the signature page; page 11 is "Print name(s) only. Do not
 * sign." and carries no widgets.
 *
 * Same date, the resale path was converged onto the generalized
 * buildMappedFieldMap/assertPlausibleMappedFieldCount machinery via
 * resaleFormEntry() — see regression-resale-esign-third-signer.js for the
 * signer-collapse coverage.
 *
 * This follows the plain-node + process.exit(1) convention of
 * scripts/regression-trec-20-19-overflow-padding.js. Run manually:
 *   node scripts/regression-trec-20-19-esign-coords.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..');
const esignCreate = require(path.join(REPO, 'api/esign-create.js'));
const {
  resaleFormEntry,
  buildMappedFieldMap,
  assertPlausibleMappedFieldCount,
  loadResaleCoords,
} = esignCreate.__testing || {};

const NEW_COORDS_PATH = path.join(REPO, 'api/_assets/trec-20-19-esign-coords.json');
const OLD_COORDS_PATH = path.join(REPO, 'api/_assets/trec-20-18-esign-coords.json');

// Pages that actually PRINT the "Initialed for identification" footer line,
// confirmed by rendering every page of the blank 20-19 (pdftoppm) and by
// Quinn's live DocuSeal signing-page pass. NOT 12 — see header.
const REAL_INITIAL_PAGES = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const SIGNATURE_PAGE = 10;
const WIDGETLESS_PAGES = [11, 12];

const BUYER_SELLER_SIGNERS = [
  { role: 'Buyer 1', name: 'Test Buyer', email: 'buyer@example.com' },
  { role: 'Seller 1', name: 'Test Seller', email: 'seller@example.com' },
];

function testTestingSurfaceExists() {
  assert.ok(esignCreate.__testing, 'api/esign-create.js must export __testing for this regression suite to run');
  assert.strictEqual(typeof resaleFormEntry, 'function', 'resaleFormEntry must be exported (resale converged onto the generalized path 2026-09-08)');
  assert.strictEqual(typeof buildMappedFieldMap, 'function');
  assert.strictEqual(typeof assertPlausibleMappedFieldCount, 'function');
  assert.strictEqual(typeof loadResaleCoords, 'function');
  console.log('  PASS: esign-create.js exposes the internals this suite needs');
}

function testCurrentCoordFileIsThe2019Map() {
  assert.ok(fs.existsSync(NEW_COORDS_PATH), 'api/_assets/trec-20-19-esign-coords.json must exist');
  const coords = JSON.parse(fs.readFileSync(NEW_COORDS_PATH, 'utf8'));
  assert.strictEqual(coords.pageCount, 12, 'coord file must declare the real 12-page 20-19 page count');
  assert.deepStrictEqual(
    coords.initialBearingPages, REAL_INITIAL_PAGES,
    'coord file must declare exactly the 9 pages that PRINT an initial line (1-9). Page 12\'s line is '
    + 'invisible text — a widget there floats on blank margin (render-confirmed 2026-09-08)'
  );
  for (const side of ['buyer', 'seller']) {
    for (const party of coords[side]) {
      const pages = party.initials.map((i) => i.page).sort((a, b) => a - b);
      assert.deepStrictEqual(pages, REAL_INITIAL_PAGES, `${side} party must have an initial on exactly pages 1-9`);
      assert.strictEqual(party.signature.page, SIGNATURE_PAGE, `${side} signature must be on the real signature page (10)`);
      for (const bad of WIDGETLESS_PAGES) {
        assert.ok(!pages.includes(bad), `${side} party must NOT map an initial onto widgetless page ${bad}`);
      }
    }
  }
  console.log('  PASS: trec-20-19-esign-coords.json covers exactly pages 1-9 for initials, page 10 for signatures, nothing on 11/12');
}

function testBuiltFieldMapHasNoWidgetOnPages11Or12() {
  const { fieldMap } = buildMappedFieldMap(resaleFormEntry(), BUYER_SELLER_SIGNERS);
  for (const [role, roleFields] of Object.entries(fieldMap)) {
    for (const f of roleFields) {
      for (const a of f.areas) {
        assert.ok(
          !WIDGETLESS_PAGES.includes(a.page),
          `${role} widget "${f.name}" landed on page ${a.page} — pages 11 and 12 print no line for ANY signer. `
          + 'This is the floating-initials defect Quinn caught on the live signing page.'
        );
      }
    }
  }
  console.log('  PASS: built resale field map places zero widgets on pages 11 and 12');
}

function testBuildPlacesAllRequiredWidgets() {
  const entry = resaleFormEntry();
  const { fieldMap } = buildMappedFieldMap(entry, BUYER_SELLER_SIGNERS);
  const total = Object.values(fieldMap).reduce((a, arr) => a + arr.length, 0);
  // 2 signers x (9 initials + 1 signature + 1 date) = 22.
  assert.strictEqual(total, 22, `expected 22 widgets for 1 buyer + 1 seller, got ${total}`);
  for (const role of ['Buyer 1', 'Seller 1']) {
    const roleFields = fieldMap[role];
    const initialPages = roleFields
      .filter((f) => f.type === 'initials')
      .map((f) => f.areas[0].page)
      .sort((a, b) => a - b);
    assert.deepStrictEqual(initialPages, REAL_INITIAL_PAGES, `${role} must get an initial widget on exactly pages 1-9`);
    const sigField = roleFields.find((f) => f.type === 'signature');
    assert.strictEqual(sigField.areas[0].page, SIGNATURE_PAGE, `${role} signature must land on page 10`);
  }
  console.log('  PASS: resale field map places all 22 required widgets (9 initial pages + page-10 signature + date per signer)');
}

function testGateAcceptsTheFixedFieldMap() {
  const entry = resaleFormEntry();
  const { fieldMap } = buildMappedFieldMap(entry, BUYER_SELLER_SIGNERS);
  assert.doesNotThrow(
    () => assertPlausibleMappedFieldCount(entry, fieldMap, BUYER_SELLER_SIGNERS),
    'the gate must NOT block a correctly-built 22-widget field map'
  );
  console.log('  PASS: generalized gate accepts the correct (post-fix) field map');
}

// "Fails against pre-fix code" proof: reconstruct the field-map shape the
// superseded 20-18 geometry produced (8 initials + sig + date per signer,
// signature on page 9) and show the CURRENT gate refuses it for a 20-19 send.
function testGateBlocksThePreFixShape() {
  assert.ok(fs.existsSync(OLD_COORDS_PATH), 'old 20-18 coord file must still be on disk for this comparison');
  const oldCoords = JSON.parse(fs.readFileSync(OLD_COORDS_PATH, 'utf8'));
  assert.strictEqual(oldCoords.buyer[0].initials.length, 8, 'sanity: the superseded 20-18 map really only has 8 initial pages');
  assert.strictEqual(oldCoords.buyer[0].signature.page, 9, 'sanity: the superseded 20-18 map really put the signature on page 9');

  function buildPreFixStyleFields(role, partyCoords) {
    const out = partyCoords.initials.map((ini) => ({
      name: `${role} Initials P${ini.page}`,
      type: 'initials',
      areas: [{ page: ini.page, ...ini }],
    }));
    out.push({ name: `${role} Signature`, type: 'signature', areas: [{ page: partyCoords.signature.page, ...partyCoords.signature }] });
    out.push({ name: `${role} Date`, type: 'date', areas: [{ page: partyCoords.signature.page, x: 0, y: 0, w: 0, h: 0 }] });
    return out;
  }
  const preFixFieldMap = {
    'Buyer 1': buildPreFixStyleFields('Buyer 1', oldCoords.buyer[0]),
    'Seller 1': buildPreFixStyleFields('Seller 1', oldCoords.seller[0]),
  };
  const preFixTotal = Object.values(preFixFieldMap).reduce((a, arr) => a + arr.length, 0);
  assert.strictEqual(preFixTotal, 20, '2 signers x (8 initials + sig + date) = 20 -- this is what actually shipped pre-2026-08-31');

  assert.throws(
    () => assertPlausibleMappedFieldCount(resaleFormEntry(), preFixFieldMap, BUYER_SELLER_SIGNERS),
    /Field placement check failed/,
    'the gate MUST block the 20-18-shaped field map (20 widgets, missing page-9 initials) for a 20-19 send'
  );
  console.log('  PASS: generalized gate BLOCKS the pre-fix 20-18-geometry field count -- confirms this suite is not a no-op');
}

async function main() {
  console.log('TREC 20-19 e-sign coordinate regression -- geometry + floating-page-12-initials fixes');
  console.log('=====================================================================');
  const tests = [
    ['esign-create.js exposes __testing internals', testTestingSurfaceExists],
    ['trec-20-19-esign-coords.json covers exactly the 9 printed initial pages + page-10 signature', testCurrentCoordFileIsThe2019Map],
    ['built field map has NO widget on pages 11/12 (floating-initials defect)', testBuiltFieldMapHasNoWidgetOnPages11Or12],
    ['resale field map places all 22 required widgets', testBuildPlacesAllRequiredWidgets],
    ['generalized gate accepts the correct field map', testGateAcceptsTheFixedFieldMap],
    ['generalized gate BLOCKS the pre-fix 20-18-on-20-19 shape (proves the suite is not a no-op)', testGateBlocksThePreFixShape],
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
