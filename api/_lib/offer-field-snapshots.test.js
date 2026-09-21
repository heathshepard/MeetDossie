'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SNAPSHOT_FIELD_NAMES,
  serializeValue,
  deserializeValue,
  planFieldSnapshots,
  planRevertPatch,
  planAcceptSnapshots,
  planAcceptPatch,
} = require('./offer-field-snapshots');

test('SNAPSHOT_FIELD_NAMES covers the full 17-field funds-due-date dependency set, not just the original 6', () => {
  assert.equal(SNAPSHOT_FIELD_NAMES.length, 17);
  for (const must of [
    'sale_price', 'contract_effective_date', 'closing_date',
    'earnest_money', 'option_fee', 'option_days',
    'option_fee_due_date', 'earnest_money_due_date',
    'earnest_money_confirmed_at', 'option_fee_confirmed_at',
  ]) {
    assert.ok(SNAPSHOT_FIELD_NAMES.includes(must), `missing ${must}`);
  }
});

test('serializeValue: null/undefined/empty-string all become null, not the string "null"', () => {
  assert.equal(serializeValue(null), null);
  assert.equal(serializeValue(undefined), null);
  assert.equal(serializeValue(''), null);
  assert.equal(serializeValue(0), '0');
  assert.equal(serializeValue(850000), '850000');
});

test('deserializeValue: numeric/integer round-trip through TEXT storage', () => {
  assert.equal(deserializeValue('sale_price', '850000'), 850000);
  assert.equal(deserializeValue('option_days', '10'), 10);
  assert.equal(deserializeValue('sale_price', null), null);
});

test('deserializeValue: date/timestamptz/text pass through as the ISO string for Postgres to parse', () => {
  assert.equal(deserializeValue('closing_date', '2026-10-29'), '2026-10-29');
  assert.equal(deserializeValue('earnest_money_confirmed_at', '2026-09-01T00:00:00.000Z'), '2026-09-01T00:00:00.000Z');
  assert.equal(deserializeValue('earnest_money_title_company', 'Alamo Title'), 'Alamo Title');
});

test('deserializeValue: garbage numeric text nulls the one field instead of throwing', () => {
  assert.equal(deserializeValue('sale_price', 'not-a-number'), null);
});

test('planFieldSnapshots: only snapshots fields the accept flow is actually about to write', () => {
  const current = { sale_price: null, closing_date: null, notes: 'irrelevant, not a snapshot field' };
  const incoming = { sale_price: 850000, closing_date: '2026-10-29' };
  const rows = planFieldSnapshots(current, incoming, { offerId: 'offer-a', transactionId: 'tx-1', userId: 'user-1' });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find((r) => r.field_name === 'sale_price'), {
    offer_id: 'offer-a', transaction_id: 'tx-1', user_id: 'user-1',
    field_name: 'sale_price', prior_value: null, new_value: '850000',
  });
});

test('planFieldSnapshots: ignores a column name outside the 17-field allowlist', () => {
  const rows = planFieldSnapshots({}, { sale_price: 1, buyer_name: 'Wren Everly' }, { offerId: 'o', transactionId: 't', userId: 'u' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].field_name, 'sale_price');
});

test('planFieldSnapshots: throws without full id set (never silently snapshot to the wrong offer/tx/user)', () => {
  assert.throws(() => planFieldSnapshots({}, { sale_price: 1 }, { offerId: 'o', transactionId: 't' }));
});

test('planRevertPatch: casts every snapshotted field back to revert onto transactions in one statement', () => {
  const snapshotRows = [
    { field_name: 'sale_price', prior_value: null },
    { field_name: 'closing_date', prior_value: '2026-08-01' },
    { field_name: 'option_days', prior_value: '10' },
  ];
  const patch = planRevertPatch(snapshotRows);
  assert.deepEqual(patch, { sale_price: null, closing_date: '2026-08-01', option_days: 10 });
});

test('planRevertPatch: ignores a row for a field outside the allowlist (defensive, should never happen)', () => {
  const patch = planRevertPatch([{ field_name: 'not_a_real_column', prior_value: 'x' }]);
  assert.deepEqual(patch, {});
});

// ---------------------------------------------------------------------------
// THE CASE THE COORDINATOR FLAGGED AS "will actually occur": offer A is
// accepted, falls through, and offer B is accepted on the rebound. Verify
// each offer's revert only ever restores ITS OWN prior state, never reaches
// into another offer's history, regardless of ordering.
// ---------------------------------------------------------------------------
test('two-offer chain: retiring offer A restores the pre-A blank state, independent of offer B ever existing', () => {
  // Transaction starts blank (pre-listing / no accepted offer yet).
  const blankTransaction = { sale_price: null, closing_date: null, option_days: null };

  // Offer A accepted: snapshot captures blank -> A's terms.
  const offerAIncoming = { sale_price: 780000, closing_date: '2026-08-15', option_days: 10 };
  const offerASnapshots = planFieldSnapshots(blankTransaction, offerAIncoming, {
    offerId: 'offer-a', transactionId: 'tx-1', userId: 'user-1',
  });

  // Offer A falls through. Revert reads back offer A's OWN snapshot rows.
  const revertA = planRevertPatch(offerASnapshots);
  assert.deepEqual(revertA, { sale_price: null, closing_date: null, option_days: null });

  // Transaction is blank again (as if offer A never happened) — this IS the
  // state the next accept snapshots against.
  const transactionAfterRevertA = revertA;

  // Offer B accepted on the rebound: snapshot captures blank -> B's terms,
  // completely independent of offer A's snapshot rows.
  const offerBIncoming = { sale_price: 795000, closing_date: '2026-10-29', option_days: 7 };
  const offerBSnapshots = planFieldSnapshots(transactionAfterRevertA, offerBIncoming, {
    offerId: 'offer-b', transactionId: 'tx-1', userId: 'user-1',
  });

  // Retiring offer B restores blank too — NOT offer A's terms. This is the
  // assertion that matters: nothing chain-walks back to A.
  const revertB = planRevertPatch(offerBSnapshots);
  assert.deepEqual(revertB, { sale_price: null, closing_date: null, option_days: null });
  assert.notDeepEqual(offerBSnapshots, offerASnapshots);
});

// ---------------------------------------------------------------------------
// planAcceptSnapshots / planAcceptPatch — the real accept-flow shape: only
// ~5 fields come from the offer row directly, but all 17 get a snapshot row
// so a later revert correctly wipes out whatever got written under this
// offer's lifecycle (funds confirmations, deposits) even though acceptance
// itself never touched them.
// ---------------------------------------------------------------------------

test('planAcceptSnapshots: snapshots all 17 fields, not just the ~5 the offer maps to', () => {
  const blank = { sale_price: null, closing_date: null, option_fee: null, option_days: null, earnest_money: null };
  const offer = { offer_price: 780000, closing_date: '2026-08-15', option_fee: 200, option_days: 10, earnest_money: 5000 };
  const rows = planAcceptSnapshots(blank, offer, { offerId: 'offer-a', transactionId: 'tx-1', userId: 'user-1' });
  assert.equal(rows.length, 17);
});

test('planAcceptSnapshots: offer-mapped fields get new_value from the offer; everything else is a no-op (new_value === prior_value)', () => {
  const blank = { sale_price: null, closing_date: null, option_fee: null, option_days: null, earnest_money: null };
  const offer = { offer_price: 780000, closing_date: '2026-08-15', option_fee: 200, option_days: 10, earnest_money: 5000 };
  const rows = planAcceptSnapshots(blank, offer, { offerId: 'offer-a', transactionId: 'tx-1', userId: 'user-1' });

  const salePrice = rows.find((r) => r.field_name === 'sale_price');
  assert.equal(salePrice.prior_value, null);
  assert.equal(salePrice.new_value, '780000');

  const confirmedAt = rows.find((r) => r.field_name === 'earnest_money_confirmed_at');
  assert.equal(confirmedAt.prior_value, null);
  assert.equal(confirmedAt.new_value, null); // untouched by acceptance — no-op row
});

test('planAcceptPatch: only writes the fields the offer actually maps to', () => {
  const offer = { offer_price: 780000, closing_date: '2026-08-15', option_fee: 200, option_days: 10, earnest_money: 5000, buyer_name: 'Wren Everly' };
  const patch = planAcceptPatch(offer);
  assert.deepEqual(patch, {
    sale_price: 780000, closing_date: '2026-08-15', option_fee: 200, option_days: 10, earnest_money: 5000,
  });
  assert.ok(!('buyer_name' in patch));
});

test('the real accept -> LATER field gets written during the deal -> retire sequence: confirming earnest money under offer A, then A falling through, wipes the confirmation, not just the 5 accept-time fields', () => {
  const blank = { sale_price: null, closing_date: null, option_fee: null, option_days: null, earnest_money: null, earnest_money_confirmed_at: null };
  const offer = { offer_price: 780000, closing_date: '2026-08-15', option_fee: 200, option_days: 10, earnest_money: 5000 };
  const acceptSnapshots = planAcceptSnapshots(blank, offer, { offerId: 'offer-a', transactionId: 'tx-1', userId: 'user-1' });

  // Deal proceeds: earnest money gets confirmed weeks later, completely
  // outside the accept flow — no new snapshot row is created for this (by
  // design, see module header). The offer's original snapshot already holds
  // prior_value=null for earnest_money_confirmed_at from accept time.
  // Retiring offer A must still null it out.
  const revert = planRevertPatch(acceptSnapshots);
  assert.equal(revert.earnest_money_confirmed_at, null);
  assert.equal(revert.sale_price, null);
});

test('two-offer chain: if offer B is accepted WITHOUT A ever being reverted (a data-integrity bug elsewhere), B still only records what IT overwrote', () => {
  // Defends the mechanism itself even if a caller misuses it — B's snapshot
  // is always relative to whatever the transaction held at B's own accept
  // moment, so replaying it never corrupts into A's values either.
  const transactionStillShowingA = { sale_price: 780000, closing_date: '2026-08-15', option_days: 10 };
  const offerBIncoming = { sale_price: 795000, closing_date: '2026-10-29', option_days: 7 };
  const offerBSnapshots = planFieldSnapshots(transactionStillShowingA, offerBIncoming, {
    offerId: 'offer-b', transactionId: 'tx-1', userId: 'user-1',
  });
  const revertB = planRevertPatch(offerBSnapshots);
  // Reverting B lands back on A's numbers, not blank — correct: B's "prior"
  // really was A's live state at that moment.
  assert.deepEqual(revertB, { sale_price: 780000, closing_date: '2026-08-15', option_days: 10 });
});
