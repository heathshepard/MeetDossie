'use strict';
// api/_lib/executed-date-field-gate.test.js
//
// Pure unit tests for the EXECUTED-date gate (see executed-date-field-gate.js
// for the full rationale). No network, no filesystem, no Supabase — every
// case here is pass-in-values / assert-the-verdict, which is what makes this
// cheap enough to run on every send path.
//
// Run: node --test api/_lib/executed-date-field-gate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hasExecutedBlock,
  isExecutedDateField,
  checkExecutedDateFieldAssignment,
} = require('./executed-date-field-gate');

// Matches real pdftotext output on the live TREC forms (verified
// 2026-10-02 against TREC 20-19, 9-17, and 39-11): the printed blanks are
// whitespace gaps, not literal underscore characters.
const EXECUTED_TEXT = 'Some contract text...\n'
  + 'EXECUTED the       day of                      , 20            (Effective Date).\n'
  + '(BROKER: FILL IN THE DATE OF FINAL ACCEPTANCE.)\n';

const NO_EXECUTED_TEXT = 'This is a disclosure notice. Seller makes no representations beyond this notice. '
  + 'Signature of Seller ___________ Date ___________';

test('hasExecutedBlock: detects the real TREC paragraph', () => {
  assert.equal(hasExecutedBlock(EXECUTED_TEXT), true);
});

test('hasExecutedBlock: a disclosure with no EXECUTED paragraph is not flagged', () => {
  assert.equal(hasExecutedBlock(NO_EXECUTED_TEXT), false);
});

test('hasExecutedBlock: non-string input is safely false', () => {
  assert.equal(hasExecutedBlock(null), false);
  assert.equal(hasExecutedBlock(undefined), false);
});

test('isExecutedDateField: matches EXECUTED-named fields, not generic per-signer date fields', () => {
  assert.equal(isExecutedDateField({ name: 'Buyer 2 Executed Day', type: 'text' }), true);
  assert.equal(isExecutedDateField({ name: 'Seller 1 Executed Month', type: 'text' }), true);
  // The pre-existing per-signer "date signed" convenience field must NEVER
  // satisfy this gate on name alone.
  assert.equal(isExecutedDateField({ name: 'Buyer 1 Date', type: 'date' }), false);
  assert.equal(isExecutedDateField({ name: 'Seller 2 Signature', type: 'signature' }), false);
});

// ---------------------------------------------------------------------------
// Test 1 (required by spec): a form with an EXECUTED block and no date
// fields at all -> refused.
// ---------------------------------------------------------------------------
test('REQUIRED: EXECUTED block + zero date fields -> refused', () => {
  const result = checkExecutedDateFieldAssignment({
    formLabel: 'TREC 39-11 Amendment',
    hasExecutedBlock: true,
    fields: [
      { name: 'Buyer 1 Signature', type: 'signature', role: 'Buyer 1' },
      { name: 'Buyer 2 Signature', type: 'signature', role: 'Buyer 2' },
    ],
    signers: [
      { name: 'Nadia Kapoor', email: 'n@example.test', role: 'Buyer 1' },
      { name: 'Rohan Desai', email: 'r@example.test', role: 'Buyer 2' },
    ],
    signingOrder: 'sequential',
  });
  assert.equal(result.ok, false);
  assert.equal(result.applicable, true);
  assert.match(result.error, /no fillable date field/i);
});

// ---------------------------------------------------------------------------
// Test 2 (required by spec): fields present but assigned to a non-last
// signer -> refused.
// ---------------------------------------------------------------------------
test('REQUIRED: EXECUTED fields assigned to the FIRST signer, not the last -> refused', () => {
  const result = checkExecutedDateFieldAssignment({
    formLabel: 'TREC 39-11 Amendment',
    hasExecutedBlock: true,
    fields: [
      { name: 'Buyer 1 Signature', type: 'signature', role: 'Buyer 1' },
      { name: 'Buyer 2 Signature', type: 'signature', role: 'Buyer 2' },
      // Wrongly assigned to Buyer 1 (first), not Buyer 2 (last) — this is
      // the exact class of bug that looks fine at a glance.
      { name: 'Buyer 1 Executed Day', type: 'text', role: 'Buyer 1' },
      { name: 'Buyer 1 Executed Month', type: 'text', role: 'Buyer 1' },
      { name: 'Buyer 1 Executed Year', type: 'text', role: 'Buyer 1' },
    ],
    signers: [
      { name: 'Nadia Kapoor', email: 'n@example.test', role: 'Buyer 1' },
      { name: 'Rohan Desai', email: 'r@example.test', role: 'Buyer 2' },
    ],
    signingOrder: 'sequential',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /signs LAST \("Buyer 2"\)/);
});

test('EXECUTED fields correctly assigned to the LAST signer -> ok', () => {
  const result = checkExecutedDateFieldAssignment({
    formLabel: 'TREC 39-11 Amendment',
    hasExecutedBlock: true,
    fields: [
      { name: 'Buyer 1 Signature', type: 'signature', role: 'Buyer 1' },
      { name: 'Buyer 2 Signature', type: 'signature', role: 'Buyer 2' },
      { name: 'Buyer 2 Executed Day', type: 'text', role: 'Buyer 2' },
      { name: 'Buyer 2 Executed Month', type: 'text', role: 'Buyer 2' },
      { name: 'Buyer 2 Executed Year', type: 'text', role: 'Buyer 2' },
    ],
    signers: [
      { name: 'Nadia Kapoor', email: 'n@example.test', role: 'Buyer 1' },
      { name: 'Rohan Desai', email: 'r@example.test', role: 'Buyer 2' },
    ],
    signingOrder: 'sequential',
  });
  assert.equal(result.ok, true);
  assert.equal(result.applicable, true);
});

// ---------------------------------------------------------------------------
// Test 3 (required by spec): a disclosure/IABS/T-47 with no EXECUTED block
// -> passes untouched, regardless of what fields/signers look like.
// ---------------------------------------------------------------------------
test('REQUIRED: no EXECUTED block (disclosure/IABS/T-47) -> passes untouched', () => {
  const result = checkExecutedDateFieldAssignment({
    formLabel: "Seller's Disclosure Notice (TXR-1406)",
    hasExecutedBlock: false,
    fields: [], // doesn't matter — applicable is false before fields are even looked at
    signers: [{ name: 'A Seller', email: 's@example.test', role: 'Seller 1' }],
    signingOrder: 'sequential',
  });
  assert.deepEqual(result, { ok: true, applicable: false });
});

// ---------------------------------------------------------------------------
// Parallel / random signing order — documented decision (see module header):
// no deterministic last signer, so the date must go to a broker/agent
// signer if one is present; otherwise refuse (never guess/default to first).
// ---------------------------------------------------------------------------
test('parallel order + no broker/agent signer present -> refused', () => {
  const result = checkExecutedDateFieldAssignment({
    formLabel: 'TREC 39-11 Amendment',
    hasExecutedBlock: true,
    fields: [
      { name: 'Buyer 2 Executed Day', type: 'text', role: 'Buyer 2' },
      { name: 'Buyer 2 Executed Month', type: 'text', role: 'Buyer 2' },
      { name: 'Buyer 2 Executed Year', type: 'text', role: 'Buyer 2' },
    ],
    signers: [
      { name: 'Nadia Kapoor', email: 'n@example.test', role: 'Buyer 1' },
      { name: 'Rohan Desai', email: 'r@example.test', role: 'Buyer 2' },
    ],
    signingOrder: 'random',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /parallel\/random/i);
});

test('parallel order + broker/agent signer present -> fields must go to the broker', () => {
  const signers = [
    { name: 'Nadia Kapoor', email: 'n@example.test', role: 'Buyer 1' },
    { name: 'Heath Shepard', email: 'h@example.test', role: 'Agent' },
  ];
  const wrongRole = checkExecutedDateFieldAssignment({
    formLabel: 'TREC 20-19',
    hasExecutedBlock: true,
    fields: [
      { name: 'Buyer 1 Executed Day', type: 'text', role: 'Buyer 1' },
      { name: 'Buyer 1 Executed Month', type: 'text', role: 'Buyer 1' },
      { name: 'Buyer 1 Executed Year', type: 'text', role: 'Buyer 1' },
    ],
    signers,
    signingOrder: 'random',
  });
  assert.equal(wrongRole.ok, false);

  const rightRole = checkExecutedDateFieldAssignment({
    formLabel: 'TREC 20-19',
    hasExecutedBlock: true,
    fields: [
      { name: 'Agent Executed Day', type: 'text', role: 'Agent' },
      { name: 'Agent Executed Month', type: 'text', role: 'Agent' },
      { name: 'Agent Executed Year', type: 'text', role: 'Agent' },
    ],
    signers,
    signingOrder: 'random',
  });
  assert.equal(rightRole.ok, true);
});

test('no signers at all -> refused rather than crash', () => {
  const result = checkExecutedDateFieldAssignment({
    formLabel: 'TREC 39-11 Amendment',
    hasExecutedBlock: true,
    fields: [{ name: 'X Executed Day', type: 'text', role: 'X' }],
    signers: [],
    signingOrder: 'sequential',
  });
  assert.equal(result.ok, false);
});
