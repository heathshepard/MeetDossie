#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-08-30 CARTER fix to the TREC 20-19 ¶21
 * NOTICES "...agent" field-coordinate swap.
 *
 * Root cause: api/_assets/trec-20-19-field-coords.json had the x-coordinates
 * for the three sellers_agent_* / buyers_agent_* field pairs (address,
 * phone, email) swapped relative to the physical page-8 layout. On the real
 * blank TREC 20-19 template (confirmed via `pdftotext -bbox` on
 * .tmp/ridgebluff-offer/blank-20-19.pdf), the LEFT column on page 8 is
 * printed "To Buyer's agent at:" and the RIGHT column is "To Seller's agent
 * at:" -- but the coord map pointed sellers_agent_* at the left column's x
 * values (~95-107) and buyers_agent_* at the right column's (~361-373). A
 * value passed as sellers_agent_email rendered under "To Buyer's agent at:"
 * and vice versa.
 *
 * This test fills the real blank asset via the production fillTrec2019()
 * path with six distinct, unambiguous sentinel values (one per field),
 * renders page 8's text layer with `pdftotext -bbox`, and asserts each
 * sentinel's bounding box sits in the physically correct column -- left
 * (x < 200) for buyer's-agent fields, right (x > 300) for seller's-agent
 * fields. This is a bbox/column check, not a mere "does the text appear
 * anywhere on the page" check, so it fails against the pre-fix coordinate
 * map (verified 2026-08-30 -- see CARTER's task report) and passes after.
 *
 * Follows the plain-node + process.exit(1) convention of
 * scripts/regression-trec-20-19-overflow-padding.js. Run manually:
 *   node scripts/regression-trec-20-19-p21-agent-columns.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');

const REPO = path.join(__dirname, '..');
const { fillTrec2019 } = require(path.join(REPO, 'api/_lib/fill-trec-20-19.js'));

const BLANK_PDF_PATH = path.join(REPO, '.tmp/ridgebluff-offer/blank-20-19.pdf');
const OUT_PATH = path.join(REPO, '.tmp/regression-p21-agent-columns.pdf');

// Column boundary in PDF points (page is 612pt wide). Left column labels
// ("Buyer's agent") sit at x approx 61-155; right column labels ("Seller's
// agent") sit at x approx 327-420. 260 is a clean midpoint with generous
// margin on both sides.
const COLUMN_BOUNDARY_X = 260;

const SENTINELS = {
  buyers_agent_address: 'BUYERADDRSENTINEL',
  buyers_agent_phone: '8085551234',
  buyers_agent_email: 'buyersentinel@test.invalid',
  sellers_agent_address: 'SELLERADDRSENTINEL',
  sellers_agent_phone: '2105559876',
  sellers_agent_email: 'sellersentinel@test.invalid',
};

async function fillAndGetBbox() {
  const bytes = fs.readFileSync(BLANK_PDF_PATH);
  const doc = await PDFDocument.load(bytes);
  await fillTrec2019(doc, { ...SENTINELS });
  const saved = await doc.save();
  fs.writeFileSync(OUT_PATH, saved);
  return execSync(`pdftotext -f 8 -l 8 -bbox "${OUT_PATH}" -`).toString();
}

function findWordXMin(bboxXml, token) {
  // pdftotext -bbox emits one <word xMin="..." ...>TEXT</word> per
  // whitespace-delimited token. All six sentinels above are single
  // unbroken tokens, so a direct substring match on the word's own text is
  // sufficient and avoids needing a full XML parser.
  const re = new RegExp(`<word xMin="([0-9.]+)"[^>]*>${token}<`, 'i');
  const m = bboxXml.match(re);
  return m ? parseFloat(m[1]) : null;
}

async function testBuyersAgentFieldsLandInLeftColumn() {
  const bboxXml = await fillAndGetBbox();
  for (const field of ['buyers_agent_address', 'buyers_agent_phone', 'buyers_agent_email']) {
    const token = SENTINELS[field];
    const xMin = findWordXMin(bboxXml, token.replace(/[.]/g, '\\.'));
    assert.ok(xMin !== null, `expected to find sentinel "${token}" (${field}) rendered on page 8`);
    assert.ok(
      xMin < COLUMN_BOUNDARY_X,
      `${field} sentinel "${token}" rendered at x=${xMin}, expected < ${COLUMN_BOUNDARY_X} (LEFT column, "To Buyer's agent at:")`
    );
  }
  console.log('  PASS: buyers_agent_address / _phone / _email all render in the LEFT column under "To Buyer\'s agent at:"');
}

async function testSellersAgentFieldsLandInRightColumn() {
  const bboxXml = await fillAndGetBbox();
  for (const field of ['sellers_agent_address', 'sellers_agent_phone', 'sellers_agent_email']) {
    const token = SENTINELS[field];
    const xMin = findWordXMin(bboxXml, token.replace(/[.]/g, '\\.'));
    assert.ok(xMin !== null, `expected to find sentinel "${token}" (${field}) rendered on page 8`);
    assert.ok(
      xMin > COLUMN_BOUNDARY_X,
      `${field} sentinel "${token}" rendered at x=${xMin}, expected > ${COLUMN_BOUNDARY_X} (RIGHT column, "To Seller's agent at:")`
    );
  }
  console.log('  PASS: sellers_agent_address / _phone / _email all render in the RIGHT column under "To Seller\'s agent at:"');
}

async function testPartyBlockAboveUnaffected() {
  // Scope guard: confirm this fix did NOT touch the buyer_notice_*/
  // seller_notice_* party block directly above the agent block, which was
  // already verified correct and explicitly out of scope.
  const { TREC_20_19_COORDS } = require(path.join(REPO, 'api/_lib/fill-trec-20-19.js'));
  const buyerNotice = TREC_20_19_COORDS.fields.buyer_notice_email;
  const sellerNotice = TREC_20_19_COORDS.fields.seller_notice_email;
  assert.ok(buyerNotice.x < COLUMN_BOUNDARY_X, 'buyer_notice_email must still be in the LEFT column');
  assert.ok(sellerNotice.x > COLUMN_BOUNDARY_X, 'seller_notice_email must still be in the LEFT column');
  console.log('  PASS: buyer_notice_email / seller_notice_email (party block above) unchanged and still correctly mapped');
}

async function main() {
  console.log('TREC 20-19 engine regression -- P21 agent-block column mapping (2026-08-30 fix)');
  console.log('=====================================================================');
  if (!fs.existsSync(BLANK_PDF_PATH)) {
    console.error('Blank asset not found at', BLANK_PDF_PATH, '-- cannot run.');
    process.exit(1);
  }
  const tests = [
    ['buyers_agent_* fields land in the LEFT ("To Buyer\'s agent at:") column', testBuyersAgentFieldsLandInLeftColumn],
    ['sellers_agent_* fields land in the RIGHT ("To Seller\'s agent at:") column', testSellersAgentFieldsLandInRightColumn],
    ['party block above (buyer_notice_*/seller_notice_*) unchanged', testPartyBlockAboveUnaffected],
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
