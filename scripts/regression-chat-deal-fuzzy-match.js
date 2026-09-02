#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-01 CARTER fix to Quinn QA Bug 6:
 * the chat dispatcher's deal_identifier resolver (findDealByIdentifier,
 * now at Dossie/src/utils/find-deal-by-identifier.js — extracted from
 * dossie-app.jsx for exactly this test) fuzzy-matched a deal when ANY
 * single word of the identifier resembled ANY single word of a deal.
 * Three brand-new, clearly distinct addresses were silently absorbed into
 * unrelated existing dossiers:
 *   "9042 Quinn QA Test Parcel" -> "999 Financial Sanity Test Ln" ("test")
 *   "5510 Ranch Road"           -> "789 Ranch Rd"                 ("ranch")
 *   "77 Builder Lane"           -> "456 Builder Blvd"             ("builder")
 * On a real member that merges a new deal into another client's file.
 *
 * Fixed rules verified here:
 *   1. Whole-identifier confidence (mean over significant words, noise
 *      street-suffix words excluded, threshold 0.85).
 *   2. Street-number gate: an identifier with a street number can only
 *      fuzzy-match a deal containing that number verbatim.
 *   3. Ambiguity -> null (refuse to guess between two close candidates).
 *   Plus: legitimate matches (exact substring, buyer name, typo tolerance,
 *   active-before-closed preference) still resolve.
 *
 * Run manually:
 *   node scripts/regression-chat-deal-fuzzy-match.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const DOSSIE_REPO = path.resolve(__dirname, '..', '..', 'Dossie');
const UTIL_PATH = path.join(DOSSIE_REPO, 'src', 'utils', 'find-deal-by-identifier.js');

const DEALS = [
  { id: 't1', propertyAddress: '999 Financial Sanity Test Ln', cityStateZip: 'Boerne, TX 78006', buyerName: 'Pat Example', sellerName: 'Sam Example', status: 'active' },
  { id: 't2', propertyAddress: '789 Ranch Rd', cityStateZip: 'San Antonio, TX 78230', buyerName: 'Maya Rivera', sellerName: 'Jake Lawson', status: 'active' },
  { id: 't3', propertyAddress: '456 Builder Blvd', cityStateZip: 'San Antonio, TX 78250', buyerName: 'Kanika Jain', sellerName: 'DR Horton', status: 'active' },
  { id: 't4', propertyAddress: '104 Wild Cherry', cityStateZip: 'San Antonio, TX 78230', buyerName: 'Chris Champie', sellerName: 'Dana Linton', status: 'active' },
  { id: 't5', propertyAddress: '104 Wild Cherry', cityStateZip: 'San Antonio, TX 78230', buyerName: 'Old Buyer', sellerName: 'Old Seller', status: 'closed' },
];

async function main() {
  console.log('deal_identifier fuzzy-match regression — 2026-09-01 Quinn QA Bug 6');
  console.log('=========================================================================================');

  assert.ok(fs.existsSync(UTIL_PATH), `matcher util missing at ${UTIL_PATH} (pre-fix code, or Dossie repo not checked out as a sibling)`);
  const { findDealByIdentifier } = await import('file://' + UTIL_PATH);

  const CASES = [
    // --- The three reproduced contaminations: brand-new addresses must NOT match.
    ['new address sharing "Test" does not absorb into 999 Financial Sanity Test Ln',
      () => assert.strictEqual(findDealByIdentifier(DEALS, '9042 Quinn QA Test Parcel'), null)],
    ['new address sharing "Ranch" does not absorb into 789 Ranch Rd',
      () => assert.strictEqual(findDealByIdentifier(DEALS, '5510 Ranch Road'), null)],
    ['new address sharing "Builder" does not absorb into 456 Builder Blvd',
      () => assert.strictEqual(findDealByIdentifier(DEALS, '77 Builder Lane'), null)],
    // --- Street-number gate.
    ['same street name but different number does not match',
      () => assert.strictEqual(findDealByIdentifier(DEALS, '790 Ranch Rd'), null)],
    // --- Legitimate matches still resolve.
    ['exact partial address resolves (substring tier)',
      () => assert.strictEqual(findDealByIdentifier(DEALS, '104 Wild Cherry').id, 't4')],
    ['buyer first name resolves',
      () => assert.strictEqual(findDealByIdentifier(DEALS, 'Kanika').id, 't3')],
    ['minor typo in a full identifier still resolves (whole-identifier fuzzy)',
      () => assert.strictEqual(findDealByIdentifier(DEALS, '104 Wild Chery').id, 't4')],
    ['street-name-only reference (no number) resolves to the only plausible deal',
      () => assert.strictEqual(findDealByIdentifier(DEALS, 'Financial Sanity').id, 't1')],
    ['active deal preferred over closed duplicate of the same address',
      () => assert.strictEqual(findDealByIdentifier(DEALS, '104 Wild Cherry').status, 'active')],
    // --- Ambiguity: two active deals at the same address -> refuse to guess.
    ['two equally plausible fuzzy candidates -> null (refuse to guess)',
      () => {
        const pool = [
          { id: 'a', propertyAddress: '210 Oak Hollow Dr', status: 'active' },
          { id: 'b', propertyAddress: '210 Oak Hollow Ct', status: 'active' },
        ];
        assert.strictEqual(findDealByIdentifier(pool, '210 Oak Holow'), null);
      }],
    ['empty / junk identifiers return null',
      () => {
        assert.strictEqual(findDealByIdentifier(DEALS, ''), null);
        assert.strictEqual(findDealByIdentifier(DEALS, '   '), null);
        assert.strictEqual(findDealByIdentifier([], '104 Wild Cherry'), null);
      }],
  ];

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
