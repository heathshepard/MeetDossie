// api/_lib/contract-term-persistence.test.js
//
// Run with: node --test api/_lib/contract-term-persistence.test.js
//
// The single question every test here answers: does Rule 1 actually hold —
// a human value always wins, a parsed value that disagrees is a conflict,
// never a silent overwrite?

const test = require('node:test');
const assert = require('node:assert/strict');

const { planContractTermWrites, TERM_FIELD_MAP } = require('./contract-term-persistence');

const SOURCE = { document_id: 'doc-1', file_name: 'contract.pdf', document_label: 'the contract' };

test('a blank field is filled from the extraction', () => {
  const plan = planContractTermWrites({
    tx: { closing_date: null },
    extracted: { closingDate: '2026-10-22' },
    documentTypeConfidence: 1,
    source: SOURCE,
  });
  assert.equal(plan.updates.closing_date, '2026-10-22');
  assert.equal(plan.filled.length, 1);
  assert.equal(plan.conflicts.length, 0);
});

test('a field that already has a DIFFERENT value is never overwritten — it becomes a conflict', () => {
  const plan = planContractTermWrites({
    tx: { closing_date: '2026-10-15' },
    extracted: { closingDate: '2026-10-22' },
    documentTypeConfidence: 1,
    source: SOURCE,
  });
  assert.equal(plan.updates.closing_date, undefined, 'must not be staged for write');
  assert.equal(plan.filled.length, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].column, 'closing_date');
  assert.equal(plan.conflicts[0].existing, '2026-10-15');
  assert.equal(plan.conflicts[0].parsed, '2026-10-22');
});

test('a field that already has the SAME value is neither filled nor conflicted', () => {
  const plan = planContractTermWrites({
    tx: { closing_date: '2026-10-22' },
    extracted: { closingDate: '2026-10-22' },
    documentTypeConfidence: 1,
    source: SOURCE,
  });
  assert.equal(Object.keys(plan.updates).length, 0);
  assert.equal(plan.filled.length, 0);
  assert.equal(plan.conflicts.length, 0);
});

test('a numeric field of exactly 0 counts as blank, not a real zero — still fillable', () => {
  const plan = planContractTermWrites({
    tx: { option_fee: 0 },
    extracted: { optionFee: 250 },
    documentTypeConfidence: 1,
    source: SOURCE,
  });
  assert.equal(plan.updates.option_fee, 250);
});

test('a numeric extraction of 0 or negative is never written — indistinguishable from unset', () => {
  const plan = planContractTermWrites({
    tx: { option_fee: null },
    extracted: { optionFee: 0 },
    documentTypeConfidence: 1,
    source: SOURCE,
  });
  assert.equal(plan.updates.option_fee, undefined);
  assert.equal(plan.filled.length, 0);
});

test('below the confidence gate, nothing is filled and nothing is flagged as a conflict', () => {
  const plan = planContractTermWrites({
    tx: { closing_date: null, sale_price: null },
    extracted: { closingDate: '2026-10-22', salePrice: 999000 },
    documentTypeConfidence: 0.5,
    source: SOURCE,
  });
  assert.equal(Object.keys(plan.updates).length, 0);
  assert.equal(plan.filled.length, 0);
  assert.equal(plan.conflicts.length, 0);
  assert.ok(plan.skippedLowConfidence.length > 0);
});

test('every TERM_FIELD_MAP column is a snake_case transactions column, never a payment-EVENT field', () => {
  const forbidden = ['earnest_money_deposited_at', 'option_fee_paid_at', 'earnest_money_confirmed_at'];
  for (const f of TERM_FIELD_MAP) {
    assert.ok(!forbidden.includes(f.column), `${f.column} is a payment-event field and must not be in this module`);
    assert.match(f.column, /^[a-z0-9_]+$/, `${f.column} is not snake_case`);
  }
});

test('multiple independent fields on one contract: fills the blanks, conflicts the mismatches, leaves matches alone', () => {
  const plan = planContractTermWrites({
    tx: {
      closing_date: null, // blank -> fill
      sale_price: 950000, // conflict
      earnest_money: 10000, // matches
      option_fee: null, // blank -> fill
    },
    extracted: {
      closingDate: '2026-10-22',
      salePrice: 999000,
      earnestMoney: 10000,
      optionFee: 250,
    },
    documentTypeConfidence: 1,
    source: SOURCE,
  });
  assert.deepEqual(Object.keys(plan.updates).sort(), ['closing_date', 'option_fee']);
  assert.equal(plan.filled.length, 2);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].column, 'sale_price');
});
