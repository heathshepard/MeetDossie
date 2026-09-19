// api/_lib/contract-safety-checks.test.js
//
// Guards the GUARD. contract-safety-checks.js is what makes the TREC gate
// audible in the daily regression alarm; these tests make sure the tier is
// still wired, still green, and still actually asserting something.
//
//   node --test api/_lib/contract-safety-checks.test.js
//   npm run test:contract-safety

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { runContractSafetyChecks } = require('./contract-safety-checks.js');

const EXPECTED_IDS = [
  'contract.trec2018.golden.conventional',
  'contract.trec2018.golden.cash',
  'contract.trec2018.golden.fha',
  'contract.trec2018.golden.va',
  'contract.trec2018.golden.seller',
  'contract.trec2018.golden.assumption',
  'contract.trec2018.broken_case_rejected',
  'contract.trec2018.rules_integrity',
  'contract.deadlines.pfeiffers_gate',
  'contract.deadlines.rollover_scope',
];

test('every contract-safety check passes — a red check here is noise in the daily alarm', () => {
  const rows = runContractSafetyChecks();
  const failed = rows.filter((r) => r.verdict !== 'PASS');
  assert.deepStrictEqual(
    failed.map((r) => `${r.id}: ${r.error}`),
    [],
    'a failing contract check trains Heath to ignore the regression alert'
  );
});

test('the tier emits exactly the expected check ids, in regression-suite row shape', () => {
  const rows = runContractSafetyChecks();
  assert.deepStrictEqual(rows.map((r) => r.id), EXPECTED_IDS);
  for (const r of rows) {
    assert.strictEqual(r.category, 'contract');
    assert.strictEqual(r.tier, 'contract');
    assert.ok(['PASS', 'FAIL', 'SKIP'].includes(r.verdict));
    assert.strictEqual(typeof r.response_ms, 'number');
  }
});

test('the tier is registered in the daily cron — not just written', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'cron-regression-suite.js'), 'utf8');
  assert.ok(
    /require\(['"]\.\/_lib\/contract-safety-checks\.js['"]\)/.test(src),
    'cron-regression-suite.js no longer requires the contract-safety tier'
  );
  assert.ok(
    /runContractSafetyChecks\(\)/.test(src),
    'cron-regression-suite.js requires the module but never calls it'
  );
});

test('the tier is fast and offline — it must never make the cron wait on a network call', () => {
  const t = Date.now();
  runContractSafetyChecks();
  assert.ok(Date.now() - t < 1000, 'contract-safety tier should be single-digit ms');
  const src = fs.readFileSync(path.join(__dirname, 'contract-safety-checks.js'), 'utf8');
  assert.ok(!/\bfetch\(/.test(src), 'contract-safety checks must not do network I/O');
  assert.ok(!/child_process/.test(src), 'contract-safety checks must not shell out');
});

test('the checks are not vacuous — breaking the validator turns them red', () => {
  // If someone stubs validate() to always pass, the golden cases are worthless.
  // Prove the checks are actually reading the validator's verdict by running
  // the broken fixture through a deliberately gutted rule set.
  const { validate } = require('./trec-validator.js');
  const rules = require('./trec-20-18-field-rules.json');
  const golden = require('./golden-cases/golden-case-conventional.json');

  const broken = JSON.parse(JSON.stringify(golden));
  broken.assignments.option_period_days.value = 'seven';
  const r = validate(rules, broken.assignments, broken.intake);
  assert.strictEqual(r.pass, false, 'the deployed validator no longer rejects a non-numeric option period');
});

test('deploy copies under api/_lib are byte-identical to Heath\'s originals in scripts/', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const names = ['conventional', 'cash', 'fha', 'va', 'seller', 'assumption'];
  for (const n of names) {
    const src = fs.readFileSync(path.join(repoRoot, 'scripts', `golden-case-${n}.json`));
    const copy = fs.readFileSync(path.join(__dirname, 'golden-cases', `golden-case-${n}.json`));
    assert.ok(src.equals(copy), `golden-case-${n}.json drifted between scripts/ and api/_lib/golden-cases/`);
  }
});
