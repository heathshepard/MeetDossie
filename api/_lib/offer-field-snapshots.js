// api/_lib/offer-field-snapshots.js
// ============================================================================
// Pure planning logic for the offers-model Rule C revert mechanism. No I/O —
// mirrors the split contract-term-persistence.js/contract-term-persistence-
// store.js already use: this file decides WHAT to write, a future
// -store.js decides HOW (the actual Supabase calls, wrapped in one atomic
// transaction per the coordinator's explicit requirement).
//
// THE 17-FIELD SCOPE CORRECTION (found pulling live DDL, 2026-09-21): the
// original design doc named 6 flat transactions columns for Rule C. The live
// schema has a DB trigger (trg_transactions_funds_due_dates) that derives
// option_fee_due_date/earnest_money_due_date from contract_effective_date on
// every write — UNLESS the same UPDATE statement explicitly sets those two
// columns too, in which case the explicit value wins (see
// funds-due-dates-trigger-sql.js's precedence comment). A revert that only
// restores the original 6 fields and lets the trigger recompute the due
// dates from the reverted effective date would leave every OTHER
// funds-tracking column (confirmations, deposits, paid-to) silently stale —
// a half-reverted deal with live deadlines. SNAPSHOT_FIELDS below is the
// full set that must move together.
//
// HOW THE REVERT STAYS CORRECT ACROSS A CHAIN (the "offer falls through, a
// backup is accepted on the rebound" case): every offer_field_snapshots row
// is keyed by offer_id, and prior_value is captured relative to whatever the
// transaction actually held the moment THAT offer was accepted — not
// relative to any other offer. Reverting offer A always means "write back
// what A itself recorded as prior_value," regardless of how many offers came
// before or after A. There is no chain-walking logic needed or wanted: each
// offer's snapshot is self-contained by construction.
//
// Owner: Carter, 2026-09-21.
// ============================================================================

// { column, type } — type controls how prior_value/new_value round-trip
// through the TEXT storage column in offer_field_snapshots.
const SNAPSHOT_FIELDS = [
  { column: 'sale_price', type: 'numeric' },
  { column: 'contract_effective_date', type: 'date' },
  { column: 'closing_date', type: 'date' },
  { column: 'earnest_money', type: 'numeric' },
  { column: 'option_fee', type: 'numeric' },
  { column: 'option_days', type: 'integer' },
  { column: 'option_fee_due_date', type: 'date' },
  { column: 'earnest_money_due_date', type: 'date' },
  { column: 'option_expiration_date', type: 'date' },
  { column: 'option_fee_amount', type: 'numeric' },
  { column: 'option_fee_paid_at', type: 'timestamptz' },
  { column: 'option_fee_paid_to', type: 'text' },
  { column: 'option_fee_confirmed_at', type: 'timestamptz' },
  { column: 'earnest_money_amount', type: 'numeric' },
  { column: 'earnest_money_deposited_at', type: 'timestamptz' },
  { column: 'earnest_money_confirmed_at', type: 'timestamptz' },
  { column: 'earnest_money_title_company', type: 'text' },
];

const SNAPSHOT_FIELD_NAMES = SNAPSHOT_FIELDS.map((f) => f.column);
const FIELD_TYPE_BY_COLUMN = new Map(SNAPSHOT_FIELDS.map((f) => [f.column, f.type]));

// Value -> TEXT for storage. null/undefined both serialize to null (stored
// NULL, not the string "null") so "the field was blank" round-trips cleanly.
function serializeValue(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

// TEXT (as read back from offer_field_snapshots) -> the JS value to write
// onto the destination transactions column. Unknown/empty stays null rather
// than throwing — a revert must never fail because one field's history is
// unreadable; it should null that one field and keep going (surfaced by the
// caller's own validation, not by an exception here).
function deserializeValue(column, text) {
  if (text === null || text === undefined) return null;
  const type = FIELD_TYPE_BY_COLUMN.get(column);
  if (type === 'numeric') {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'integer') {
    const n = parseInt(text, 10);
    return Number.isFinite(n) ? n : null;
  }
  // date / timestamptz / text all pass through as the string Postgres gave
  // us — Postgres itself parses the ISO string back into the column's real
  // type on write.
  return text;
}

/**
 * Build the offer_field_snapshots rows to insert the moment an offer's
 * terms are about to be written onto `transactions`.
 *
 * @param {object} currentTransactionRow - the transaction row's CURRENT
 *   values, read immediately before the accept write (this becomes
 *   prior_value).
 * @param {object} incomingFields - the field values the accept flow is
 *   about to write (subset of SNAPSHOT_FIELD_NAMES; only provided keys are
 *   snapshotted — a field the accept flow doesn't touch has nothing to
 *   revert).
 * @param {{offerId: string, transactionId: string, userId: string}} ids
 * @returns {Array<object>} rows ready for offer_field_snapshots insert
 *   (captured_at intentionally omitted — DB default NOW() owns it).
 */
function planFieldSnapshots(currentTransactionRow, incomingFields, ids) {
  if (!ids || !ids.offerId || !ids.transactionId || !ids.userId) {
    throw new Error('planFieldSnapshots requires offerId, transactionId, and userId.');
  }
  const row = currentTransactionRow || {};
  const incoming = incomingFields || {};

  return Object.keys(incoming)
    .filter((column) => SNAPSHOT_FIELD_NAMES.includes(column))
    .map((column) => ({
      offer_id: ids.offerId,
      transaction_id: ids.transactionId,
      user_id: ids.userId,
      field_name: column,
      prior_value: serializeValue(row[column]),
      new_value: serializeValue(incoming[column]),
    }));
}

/**
 * Build the PATCH body to write back onto `transactions` when retiring an
 * accepted offer — one flat object covering every snapshotted field in one
 * shot, so a single UPDATE statement carries it (required for the funds-
 * due-date trigger's precedence rule to treat every value as caller-
 * supplied instead of recomputing a subset).
 *
 * @param {Array<{field_name: string, prior_value: string|null}>} snapshotRows
 *   - the offer_field_snapshots rows for the offer being retired, exactly as
 *   read from the DB (any order, must all belong to one offer_id — that's
 *   the caller's responsibility, not re-checked here).
 * @returns {object} { [column]: value } — value is null for a field that
 *   was blank before this offer touched it.
 */
function planRevertPatch(snapshotRows) {
  const rows = Array.isArray(snapshotRows) ? snapshotRows : [];
  const patch = {};
  for (const row of rows) {
    if (!row || !SNAPSHOT_FIELD_NAMES.includes(row.field_name)) continue;
    patch[row.field_name] = deserializeValue(row.field_name, row.prior_value);
  }
  return patch;
}

// Which transaction_offers columns feed which transactions columns at the
// moment an offer is accepted. Deliberately small — most of SNAPSHOT_FIELDS
// (the due-date/confirmation/deposit columns) are NOT set by acceptance
// itself; they get written later in the deal's life by the funds-due-date
// trigger, contract-term-persistence.js, or manual TC edits. They're still
// snapshotted at accept time (see planAcceptSnapshots) purely so a later
// revert has a correct pre-offer prior_value for them too — accepting an
// offer is what starts that field's lifecycle even though the offer's own
// row doesn't carry the value.
const OFFER_TO_TRANSACTION_FIELD_MAP = {
  offer_price: 'sale_price',
  closing_date: 'closing_date',
  option_fee: 'option_fee',
  option_days: 'option_days',
  earnest_money: 'earnest_money',
};

/**
 * Build the FULL 17-field offer_field_snapshots rows for an offer
 * acceptance. Every SNAPSHOT_FIELDS column gets a row — the ~5 the offer
 * directly maps to get new_value = the offer's value; every other field
 * (due dates, confirmations, deposits, title company) gets new_value equal
 * to its own prior_value (untouched by acceptance itself, but still
 * captured so a future revert correctly wipes out whatever got written
 * under this offer's lifecycle later, without needing to track every
 * intermediate write separately — see the module header comment).
 *
 * @param {object} currentTransactionRow - transaction row's values
 *   immediately before this offer's terms are applied.
 * @param {object} offer - the transaction_offers row being accepted.
 * @param {{offerId: string, transactionId: string, userId: string}} ids
 * @returns {Array<object>} all 17 snapshot rows.
 */
function planAcceptSnapshots(currentTransactionRow, offer, ids) {
  if (!ids || !ids.offerId || !ids.transactionId || !ids.userId) {
    throw new Error('planAcceptSnapshots requires offerId, transactionId, and userId.');
  }
  const row = currentTransactionRow || {};
  const off = offer || {};

  return SNAPSHOT_FIELDS.map(({ column }) => {
    const priorValue = serializeValue(row[column]);
    const offerColumn = Object.keys(OFFER_TO_TRANSACTION_FIELD_MAP)
      .find((k) => OFFER_TO_TRANSACTION_FIELD_MAP[k] === column);
    const newValue = offerColumn && off[offerColumn] != null
      ? serializeValue(off[offerColumn])
      : priorValue; // untouched by acceptance — new_value == prior_value
    return {
      offer_id: ids.offerId,
      transaction_id: ids.transactionId,
      user_id: ids.userId,
      field_name: column,
      prior_value: priorValue,
      new_value: newValue,
    };
  });
}

/**
 * Build the PATCH body to write onto `transactions` when an offer is
 * accepted — only the fields the offer actually maps to (the other 12 are
 * snapshotted as no-ops, not written, since acceptance itself doesn't know
 * their values).
 *
 * @param {object} offer - the transaction_offers row being accepted.
 * @returns {object} { [transactionsColumn]: value }
 */
function planAcceptPatch(offer) {
  const off = offer || {};
  const patch = {};
  for (const [offerColumn, txColumn] of Object.entries(OFFER_TO_TRANSACTION_FIELD_MAP)) {
    if (off[offerColumn] != null) patch[txColumn] = off[offerColumn];
  }
  return patch;
}

module.exports = {
  SNAPSHOT_FIELDS,
  SNAPSHOT_FIELD_NAMES,
  OFFER_TO_TRANSACTION_FIELD_MAP,
  serializeValue,
  deserializeValue,
  planFieldSnapshots,
  planRevertPatch,
  planAcceptSnapshots,
  planAcceptPatch,
};
