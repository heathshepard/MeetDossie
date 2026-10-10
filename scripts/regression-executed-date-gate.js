#!/usr/bin/env node
/**
 * scripts/regression-executed-date-gate.js
 *
 * End-to-end regression for the EXECUTED-date gate — run against the REAL
 * committed form assets (TREC 39-11, 20-19, 9-17, TXR-1406), never a
 * hand-typed fixture. Synthetic test names only (per instruction: no real
 * client document, no credential material).
 *
 * THE REAL REGRESSION: rebuilds the exact shape of the TREC 39-11
 * buyer-name amendment that shipped for e-signature with the EXECUTED
 * paragraph left blank (scripts/send-trec-amendment.js's ORIGINAL field
 * set — two signature widgets, zero date widgets, DocuSeal order:'random')
 * and asserts the gate now refuses it. Then confirms the fixed shape (an
 * `executedDate` block assigned to the last signer, sequential order)
 * is accepted.
 *
 * Usage: node scripts/regression-executed-date-gate.js
 * Exits 1 on any failure.
 */

'use strict';

const assert = require('node:assert/strict');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
process.env.DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY || 'regression-test-placeholder-not-used';

const { fill, buildFieldsAndGate } = require(path.join(REPO, 'scripts', 'send-trec-amendment.js'));
const { bakeAddress, buildDsFields, extractPdfText: extractTxrText } = require(path.join(REPO, 'scripts', 'build-txr-1406-packet.js'));
const { hasExecutedBlock, checkExecutedDateFieldAssignment } = require(path.join(REPO, 'api', '_lib', 'executed-date-field-gate'));
const esignCreate = require(path.join(REPO, 'api', 'esign-create.js'));
const {
  resolveEsignFieldMapForDoc,
  resaleFormEntry,
  buildMappedFieldMap,
  assertPlausibleMappedFieldCount,
  formHasExecutedBlock,
} = esignCreate.__testing;

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`PASS  ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${label}\n      ${err.message}`);
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    console.log(`PASS  ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${label}\n      ${err.message}`);
  }
}

function flatten(fieldMap) {
  return Object.entries(fieldMap).flatMap(([role, fields]) => fields.map((f) => ({ ...f, role })));
}

(async () => {
  // -------------------------------------------------------------------
  // THE REAL REGRESSION — TREC 39-11 buyer-name amendment, as it actually
  // shipped: real blank asset, 2 buyer signers, no executedDate block,
  // default order ('random'). Must be refused.
  // -------------------------------------------------------------------
  const amendment39_11Base64 = require(path.join(REPO, 'api', '_assets', 'trec-amendment-39-11-base64.js'));
  const amendmentPdfBytes = Buffer.from(
    typeof amendment39_11Base64 === 'string' ? amendment39_11Base64 : amendment39_11Base64.base64Pdf,
    'base64',
  );
  const fs = require('fs');
  const os = require('os');
  const scratchDir = fs.mkdirSync(path.join(os.tmpdir(), `executed-gate-regression-${process.pid}`), { recursive: true }) || path.join(os.tmpdir(), `executed-gate-regression-${process.pid}`);
  const blankFormPath = path.join(scratchDir, 'TREC-39-11-blank.pdf');
  fs.writeFileSync(blankFormPath, amendmentPdfBytes);

  const regressionSpec = {
    form: path.relative(REPO, blankFormPath),
    out: path.relative(REPO, path.join(scratchDir, 'Amendment-regression-no-execdate.pdf')),
    fields: { 'Street Address and City': '123 Synthetic Test Ln, San Antonio, TX' },
    checks: [],
    signers: [
      { role: 'Buyer 1', name: 'Synthetic Buyer One', email: 'synthetic-buyer-1@example.test', sig: [36, 168, 260, 32] },
      { role: 'Buyer 2', name: 'Synthetic Buyer Two', email: 'synthetic-buyer-2@example.test', sig: [35, 125, 262, 32] },
    ],
    subject: 'Synthetic Regression — Amendment (no executedDate)',
    // order intentionally omitted -> defaults to 'random', matching the
    // real script's historical, unmodified default.
  };

  await checkAsync('REAL REGRESSION: 39-11 buyer-name amendment with no executedDate block -> gate refuses', async () => {
    const pdfPath = await fill(regressionSpec);
    assert.throws(
      () => buildFieldsAndGate(regressionSpec, pdfPath),
      /no fillable date field was placed/i,
    );
  });

  const fixedSpec = {
    ...regressionSpec,
    out: path.relative(REPO, path.join(scratchDir, 'Amendment-regression-fixed.pdf')),
    executedDate: {
      day: [126.7, 222.2, 38.4, 12.7],
      month: [203.3, 221.7, 170.4, 12.7],
      year: [395.3, 222.2, 34.6, 12.7],
    },
    order: 'preserved',
  };
  await checkAsync('fixed spec: executedDate present, assigned to last signer, sequential order -> gate accepts', async () => {
    const pdfPath = await fill(fixedSpec);
    const result = buildFieldsAndGate(fixedSpec, pdfPath);
    const execFields = result.fields.filter((f) => /executed/i.test(f.name));
    assert.equal(execFields.length, 3);
    assert.ok(execFields.every((f) => f.role === 'Buyer 2'), 'all EXECUTED fields must belong to the LAST signer (Buyer 2)');
  });

  const wrongOrderSpec = { ...fixedSpec, order: undefined };
  delete wrongOrderSpec.order;
  await checkAsync('fixed fields but default (random) order, no broker signer -> gate still refuses', async () => {
    const pdfPath = await fill(wrongOrderSpec);
    assert.throws(
      () => buildFieldsAndGate(wrongOrderSpec, pdfPath),
      /parallel\/random/i,
    );
  });

  // -------------------------------------------------------------------
  // scripts/build-txr-1406-packet.js — disclosure, no EXECUTED block,
  // must pass through untouched.
  // -------------------------------------------------------------------
  await checkAsync('build-txr-1406-packet.js: disclosure has no EXECUTED block -> gate is a no-op', async () => {
    const bakedBytes = await bakeAddress('123 Synthetic Test Ln, San Antonio, TX 78261');
    const fieldMapPath = path.join(REPO, 'api', '_assets', 'field-maps', 'txr-1406-sellers-disclosure-docuseal-fields.json');
    const { fields } = JSON.parse(fs.readFileSync(fieldMapPath, 'utf8'));
    const docFields = buildDsFields(fields, { seller1Name: 'Synthetic Seller', seller1Email: 'synthetic-seller@example.test' });
    const applicable = hasExecutedBlock(extractTxrText(bakedBytes));
    assert.equal(applicable, false);
    const result = checkExecutedDateFieldAssignment({
      formLabel: 'TXR-1406 regression',
      hasExecutedBlock: applicable,
      fields: docFields,
      signers: [{ role: 'Seller 1', name: 'Synthetic Seller', email: 'synthetic-seller@example.test' }],
      signingOrder: 'preserved',
    });
    assert.equal(result.ok, true);
    assert.equal(result.applicable, false);
  });

  // -------------------------------------------------------------------
  // api/esign-create.js committed path — resale_contract (TREC 20-19) and
  // unimproved-property (TREC 9-17): EXECUTED fields now present and
  // assigned to whichever signer is last.
  // -------------------------------------------------------------------
  check('esign-create.js: TREC 20-19 (resale_contract), seller last -> EXECUTED fields on Seller 1', () => {
    const formEntry = resaleFormEntry();
    const signers = [
      { name: 'Synthetic Buyer', email: 'b@example.test', role: 'Buyer 1' },
      { name: 'Synthetic Seller', email: 's@example.test', role: 'Seller 1' },
    ];
    const built = buildMappedFieldMap(formEntry, signers);
    assertPlausibleMappedFieldCount(formEntry, built.fieldMap, signers, 'regression-20-19');
    const flat = flatten(built.fieldMap);
    const gateResult = checkExecutedDateFieldAssignment({
      formLabel: 'TREC 20-19 regression',
      hasExecutedBlock: formHasExecutedBlock(formEntry.form_type),
      fields: flat,
      signers,
      signingOrder: 'sequential',
    });
    assert.equal(gateResult.ok, true);
    const execFields = flat.filter((f) => /executed/i.test(f.name));
    assert.equal(execFields.length, 3);
    assert.ok(execFields.every((f) => f.role === 'Seller 1'));
  });

  check('esign-create.js: TREC 20-19 (resale_contract), agent appended last -> EXECUTED fields on Agent', () => {
    const formEntry = resaleFormEntry();
    const signers = [
      { name: 'Synthetic Buyer', email: 'b@example.test', role: 'Buyer 1' },
      { name: 'Synthetic Seller', email: 's@example.test', role: 'Seller 1' },
      { name: 'Heath', email: 'h@example.test', role: 'Agent' },
    ];
    const built = buildMappedFieldMap(formEntry, signers);
    assertPlausibleMappedFieldCount(formEntry, built.fieldMap, signers, 'regression-20-19-agent');
    const flat = flatten(built.fieldMap);
    const execFields = flat.filter((f) => /executed/i.test(f.name));
    assert.equal(execFields.length, 3);
    assert.ok(execFields.every((f) => f.role === 'Agent'));
  });

  check('esign-create.js: TREC 9-17 (unimproved-property) -> EXECUTED fields on last signer', () => {
    const formEntry = resolveEsignFieldMapForDoc({ form_type: 'unimproved-property' });
    const signers = [
      { name: 'Synthetic Buyer', email: 'b@example.test', role: 'Buyer 1' },
      { name: 'Synthetic Seller', email: 's@example.test', role: 'Seller 1' },
    ];
    const built = buildMappedFieldMap(formEntry, signers);
    assertPlausibleMappedFieldCount(formEntry, built.fieldMap, signers, 'regression-9-17');
    const flat = flatten(built.fieldMap);
    const execFields = flat.filter((f) => /executed/i.test(f.name));
    assert.equal(execFields.length, 3);
    assert.ok(execFields.every((f) => f.role === 'Seller 1'));
  });

  check("esign-create.js: TREC 55-1 (sellers-disclosure-trec-55-1) has no EXECUTED block -> untouched", () => {
    // 2026-10-09 CARTER — 'sellers-disclosure' now means TXR 1406; this
    // Mode-A map entry (and this test) is specifically about TREC 55-1,
    // which moved to its own distinct key.
    const formEntry = resolveEsignFieldMapForDoc({ form_type: 'sellers-disclosure-trec-55-1' });
    assert.equal(formHasExecutedBlock(formEntry.form_type), false);
    const signers = [{ name: 'Synthetic Seller', email: 's@example.test', role: 'Seller 1' }];
    const built = buildMappedFieldMap(formEntry, signers);
    const flat = flatten(built.fieldMap);
    const execFields = flat.filter((f) => /executed/i.test(f.name));
    assert.equal(execFields.length, 0);
  });

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED.`);
    process.exit(1);
  }
  console.log('All checks passed.');
})().catch((err) => {
  console.error('REGRESSION SCRIPT THREW:', err && err.stack || err);
  process.exit(1);
});
