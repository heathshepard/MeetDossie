#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-08-31 e-sign geometry fix in api/esign-create.js.
 *
 * Pre-fix behavior (still visible in git history and in the untouched
 * api/_assets/trec-20-18-esign-coords.json file kept on disk for this
 * comparison): esign-create.js loaded TREC 20-18's coord map (8
 * initial-bearing pages, 1-8, signature on page 9) and applied it unchanged
 * to the 12-page TREC 20-19 document (10 initial-bearing pages: 1-9 and 12;
 * signature block on page 10). At least 2 pages of required initials (9 and
 * 12) were never placed on every 20-19 packet sent, and there was no gate
 * that would have caught it -- a 200 from DocuSeal looked identical whether
 * the packet was complete or missing initials on 2 pages.
 *
 * Post-fix: api/_assets/trec-20-19-esign-coords.json (extracted directly
 * from the real 20-19 AcroForm widget rects) covers all 10 initial-bearing
 * pages + the real page-10 signature block, and
 * assertPlausibleResaleFieldCount() BLOCKS (throws, does not warn) if a
 * built field map is short of the expected count for its signer set.
 *
 * This follows the plain-node + process.exit(1) convention of
 * scripts/regression-trec-20-19-overflow-padding.js and
 * scripts/regression-trec-20-19-p21-agent-columns.js. Run manually:
 *   node scripts/regression-trec-20-19-esign-coords.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..');
const esignCreate = require(path.join(REPO, 'api/esign-create.js'));
const {
  buildResaleContractFieldMap,
  assertPlausibleResaleFieldCount,
  loadResaleCoords,
} = esignCreate.__testing || {};

const NEW_COORDS_PATH = path.join(REPO, 'api/_assets/trec-20-19-esign-coords.json');
const OLD_COORDS_PATH = path.join(REPO, 'api/_assets/trec-20-18-esign-coords.json');

const BUYER_SELLER_SIGNERS = [
  { role: 'Buyer 1', name: 'Test Buyer', email: 'buyer@example.com' },
  { role: 'Seller 1', name: 'Test Seller', email: 'seller@example.com' },
];

function testTestingSurfaceExists() {
  assert.ok(esignCreate.__testing, 'api/esign-create.js must export __testing for this regression suite to run');
  assert.strictEqual(typeof buildResaleContractFieldMap, 'function');
  assert.strictEqual(typeof assertPlausibleResaleFieldCount, 'function');
  console.log('  PASS: esign-create.js exposes the internals this suite needs');
}

function testCurrentCoordFileIsThe2019Map() {
  assert.ok(fs.existsSync(NEW_COORDS_PATH), 'api/_assets/trec-20-19-esign-coords.json must exist');
  const coords = JSON.parse(fs.readFileSync(NEW_COORDS_PATH, 'utf8'));
  assert.strictEqual(coords.pageCount, 12, 'coord file must declare the real 12-page 20-19 page count');
  const expectedInitialPages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12];
  assert.deepStrictEqual(
    coords.initialBearingPages, expectedInitialPages,
    'coord file must declare exactly the 10 real initial-bearing pages (1-9, 12) -- NOT the 20-18 shape (1-8)'
  );
  for (const side of ['buyer', 'seller']) {
    for (const party of coords[side]) {
      const pages = party.initials.map((i) => i.page).sort((a, b) => a - b);
      assert.deepStrictEqual(pages, expectedInitialPages, `${side} party must have an initial on all 10 real pages`);
      assert.strictEqual(party.signature.page, 10, `${side} signature must be on the real signature page (10), not 9`);
    }
  }
  console.log('  PASS: trec-20-19-esign-coords.json covers pages 1-9+12 for initials and page 10 for signatures');
}

function testBuildResaleContractFieldMapPlacesAllRequiredWidgets() {
  const fieldMap = buildResaleContractFieldMap(BUYER_SELLER_SIGNERS);
  assert.ok(fieldMap, 'field map must build for a buyer+seller signer set');
  const total = Object.values(fieldMap).reduce((a, arr) => a + arr.length, 0);
  // 2 signers x (10 initials + 1 signature + 1 date) = 24.
  assert.strictEqual(total, 24, `expected 24 widgets for 1 buyer + 1 seller, got ${total}`);

  for (const role of ['Buyer 1', 'Seller 1']) {
    const roleFields = fieldMap[role];
    const initialPages = roleFields
      .filter((f) => f.type === 'initials')
      .map((f) => f.areas[0].page)
      .sort((a, b) => a - b);
    assert.deepStrictEqual(
      initialPages, [1, 2, 3, 4, 5, 6, 7, 8, 9, 12],
      `${role} must get an initial widget on pages 9 and 12 -- these are exactly the pages the pre-fix 20-18 map dropped`
    );
    const sigField = roleFields.find((f) => f.type === 'signature');
    assert.strictEqual(sigField.areas[0].page, 10, `${role} signature must land on page 10, not the 20-18 page 9`);
  }
  console.log('  PASS: buildResaleContractFieldMap places initials on all 10 real pages (including 9 and 12) and signature on page 10');
}

function testGateAcceptsTheFixedFieldMap() {
  const fieldMap = buildResaleContractFieldMap(BUYER_SELLER_SIGNERS);
  assert.doesNotThrow(
    () => assertPlausibleResaleFieldCount(fieldMap, BUYER_SELLER_SIGNERS),
    'the gate must NOT block a correctly-built 24-widget field map'
  );
  console.log('  PASS: tag-count gate accepts the correct (post-fix) field map');
}

// This is the "fails against pre-fix code" proof required by the task. It
// does not need to actually swap in the old 20-18 file at runtime -- it
// reconstructs precisely the shape esign-create.js produced before today's
// fix (8 initials + 1 signature, using the OLD file's own real page numbers)
// and shows the NEW gate function correctly refuses to send it. Before
// today, this exact object would have been passed straight to
// docusealCreateFromPdf with no check at all.
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
  assert.strictEqual(preFixTotal, 20, '2 signers x (8 initials + sig + date) = 20 -- this is what actually shipped pre-fix');

  assert.throws(
    () => assertPlausibleResaleFieldCount(preFixFieldMap, BUYER_SELLER_SIGNERS),
    /Field placement check failed/,
    'the gate MUST block the pre-fix 20-18-shaped field map (20 widgets, missing pages 9 and 12) for a 20-19 send -- '
    + 'this is the exact defect that shipped a packet with 2 pages of missing initials'
  );
  console.log('  PASS: tag-count gate BLOCKS the pre-fix (20-18-geometry-on-20-19) field count -- confirms this suite is not a no-op');
}

async function main() {
  console.log('TREC 20-19 e-sign coordinate regression -- 20-18-geometry-on-20-19 fix');
  console.log('=====================================================================');
  const tests = [
    ['esign-create.js exposes __testing internals', testTestingSurfaceExists],
    ['trec-20-19-esign-coords.json covers the real 10 initial pages + page-10 signature', testCurrentCoordFileIsThe2019Map],
    ['buildResaleContractFieldMap places all 24 required widgets, including pages 9 & 12', testBuildResaleContractFieldMapPlacesAllRequiredWidgets],
    ['tag-count gate accepts the correct field map', testGateAcceptsTheFixedFieldMap],
    ['tag-count gate BLOCKS the pre-fix 20-18-on-20-19 shape (proves the suite is not a no-op)', testGateBlocksThePreFixShape],
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
