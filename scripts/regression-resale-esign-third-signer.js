#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-08 resale (TREC 20-19) signer-collapse fix
 * in api/esign-create.js.
 *
 * Pre-fix defect: buildResaleContractFieldMap used `Math.min(sideIndex, 1)`,
 * so a 3rd buyer was silently assigned the IDENTICAL signature/initials rects
 * as buyer 2 (e.g. signature page:10 x:0.1187 y:0.5236) — two different
 * people wired to sign the same printed line. assertPlausibleResaleFieldCount
 * only compared a TOTAL widget count (and only in the "fewer than expected"
 * direction), so the collapsed packet sailed through the gate and out to
 * DocuSeal.
 *
 * Post-fix: the resale path is converged onto the generalized
 * buildMappedFieldMap + assertPlausibleMappedFieldCount machinery via
 * resaleFormEntry(). The 20-19 prints exactly two signature lines and two
 * footer-initial blanks per side, so a request naming a 3rd buyer or seller
 * is REFUSED with a 422 (a form that cannot represent the signer set must
 * fail loudly, never stack two people on one line). Duplicate role names and
 * unclassifiable roles are refused the same way.
 *
 * This suite is written to RUN against pre-fix code too (it falls back to the
 * old buildResaleContractFieldMap export when resaleFormEntry is absent) so
 * the disposable-worktree proof shows real behavioral failures, not a missing
 * export. Run manually:
 *   node scripts/regression-resale-esign-third-signer.js
 */

const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..');
const esignCreate = require(path.join(REPO, 'api/esign-create.js'));
const T = esignCreate.__testing || {};

// Build the resale field map exactly the way the handler would, on either
// side of the fix. Returns { fieldMap, mode }.
function buildResaleMapCompat(signers) {
  if (typeof T.resaleFormEntry === 'function' && typeof T.buildMappedFieldMap === 'function') {
    const entry = T.resaleFormEntry();
    const { fieldMap } = T.buildMappedFieldMap(entry, signers);
    if (typeof T.assertPlausibleMappedFieldCount === 'function') {
      T.assertPlausibleMappedFieldCount(entry, fieldMap, signers);
    }
    return { fieldMap, mode: 'converged' };
  }
  // Pre-fix surface.
  const fieldMap = T.buildResaleContractFieldMap(signers);
  if (typeof T.assertPlausibleResaleFieldCount === 'function') {
    T.assertPlausibleResaleFieldCount(fieldMap, signers);
  }
  return { fieldMap, mode: 'legacy' };
}

const THREE_BUYERS = [
  { role: 'Buyer 1', name: 'B One', email: 'b1@example.com' },
  { role: 'Buyer 2', name: 'B Two', email: 'b2@example.com' },
  { role: 'Buyer 3', name: 'B Three', email: 'b3@example.com' },
  { role: 'Seller 1', name: 'S One', email: 's1@example.com' },
];

const THREE_SELLERS = [
  { role: 'Buyer 1', name: 'B One', email: 'b1@example.com' },
  { role: 'Seller 1', name: 'S One', email: 's1@example.com' },
  { role: 'Seller 2', name: 'S Two', email: 's2@example.com' },
  { role: 'Seller 3', name: 'S Three', email: 's3@example.com' },
];

const FULL_VALID_PACKET = [
  { role: 'Buyer 1', name: 'B One', email: 'b1@example.com' },
  { role: 'Buyer 2', name: 'B Two', email: 'b2@example.com' },
  { role: 'Seller 1', name: 'S One', email: 's1@example.com' },
  { role: 'Seller 2', name: 'S Two', email: 's2@example.com' },
  { role: 'Agent', name: 'A Gent', email: 'agent@example.com' },
];

function rectKey(f, a) {
  return `${f.type}|p${a.page}|${a.x}|${a.y}|${a.w}|${a.h}`;
}

function testThirdBuyerIsRefusedWith422() {
  let threw = null;
  try {
    buildResaleMapCompat(THREE_BUYERS);
  } catch (e) {
    threw = e;
  }
  assert.ok(
    threw,
    'a 3-buyer resale packet MUST be refused — the 20-19 has exactly two printed buyer signature '
    + 'lines; pre-fix code silently stacked buyer 3 onto buyer 2\'s rects and sent it'
  );
  assert.strictEqual(threw.status, 422, `refusal must be a 422 ValidationError, got status=${threw.status} (${threw.message})`);
  assert.match(threw.message, /signature lines for 2 buyer/i, 'the 422 must tell the agent WHY (two printed lines, request names more)');
  console.log('  PASS: 3-buyer packet is refused with an explanatory 422, not silently collapsed');
}

function testThirdSellerIsRefusedWith422() {
  let threw = null;
  try {
    buildResaleMapCompat(THREE_SELLERS);
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'a 3-seller resale packet MUST be refused, same as 3 buyers');
  assert.strictEqual(threw.status, 422);
  console.log('  PASS: 3-seller packet is refused with a 422');
}

function testNoTwoSignersShareAnyRect() {
  // If the 3-buyer build DOESN'T throw (pre-fix behavior), prove the collapse
  // directly: buyer 3's widgets duplicate buyer 2's rect-for-rect.
  let fieldMap;
  try {
    fieldMap = buildResaleMapCompat(THREE_BUYERS).fieldMap;
  } catch (e) {
    fieldMap = null; // post-fix: refused upstream — nothing can collide
  }
  if (fieldMap) {
    const seen = new Map(); // rectKey -> role
    for (const [role, roleFields] of Object.entries(fieldMap)) {
      for (const f of roleFields) {
        for (const a of f.areas) {
          const key = rectKey(f, a);
          const prior = seen.get(key);
          assert.ok(
            !prior || prior === role,
            `signers "${prior}" and "${role}" are both assigned the SAME ${f.type} rect (${key}) — `
            + 'two different people wired to the same printed line. This is the exact defect: '
            + 'Math.min(sideIndex, 1) collapsed buyer 3 onto buyer 2.'
          );
          seen.set(key, role);
        }
      }
    }
  }
  console.log('  PASS: no two signers share a widget rect (3-buyer packet either refused or fully distinct)');
}

function testValidFullPacketStillBuilds() {
  const { fieldMap, mode } = buildResaleMapCompat(FULL_VALID_PACKET);
  assert.ok(fieldMap, '2 buyers + 2 sellers + agent is a legitimate packet and must still build');
  for (const role of ['Buyer 1', 'Buyer 2', 'Seller 1', 'Seller 2']) {
    const fields = fieldMap[role] || [];
    assert.ok(fields.some((f) => f.type === 'signature'), `${role} must have a signature widget`);
    assert.ok(fields.some((f) => f.type === 'initials'), `${role} must have initials widgets`);
  }
  // Distinctness across the valid packet too.
  const seen = new Map();
  for (const [role, roleFields] of Object.entries(fieldMap)) {
    for (const f of roleFields) {
      for (const a of f.areas) {
        const key = rectKey(f, a);
        assert.ok(!seen.has(key), `"${seen.get(key)}" and "${role}" share rect ${key} in a valid packet`);
        seen.set(key, role);
      }
    }
  }
  console.log(`  PASS: full valid packet (2B/2S/agent) builds with fully distinct rects (${mode} path)`);
}

function testNoWidgetOnPage12() {
  // Defect 1 coverage at the built-map level: page 12 prints no initial line
  // (its "Initialed for identification" text run is invisible when rendered —
  // Quinn saw the widgets floating on blank margin on the live signing page).
  const { fieldMap } = buildResaleMapCompat(FULL_VALID_PACKET);
  for (const [role, roleFields] of Object.entries(fieldMap)) {
    for (const f of roleFields) {
      for (const a of f.areas) {
        assert.notStrictEqual(
          a.page, 12,
          `${role} widget "${f.name}" is placed on page 12, which prints no line for any signer — floating-widget defect`
        );
      }
    }
  }
  console.log('  PASS: no widget of any type lands on page 12');
}

async function main() {
  console.log('Resale e-sign third-signer collapse regression -- 2026-09-08 fix');
  console.log('=====================================================================');
  const tests = [
    ['3-buyer packet is refused with 422 (never silently collapsed)', testThirdBuyerIsRefusedWith422],
    ['3-seller packet is refused with 422', testThirdSellerIsRefusedWith422],
    ['no two signers ever share a widget rect', testNoTwoSignersShareAnyRect],
    ['valid 2B/2S/agent packet still builds, rects fully distinct', testValidFullPacketStillBuilds],
    ['no widget lands on page 12 (floating-initials defect)', testNoWidgetOnPage12],
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
