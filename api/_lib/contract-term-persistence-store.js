'use strict';

// api/_lib/contract-term-persistence-store.js
//
// The I/O half of contract-term-persistence.js. That module decides WHAT to
// write; this is the only thing here that touches a row. Same multi-tenancy
// contract as contact-persistence-store.js: every read AND write carries
// user_id=eq.<session user>, combined into the write filter rather than a
// separate ownership check (check-then-write has a window; the combined
// filter does not) — transactions is multi-tenant
// (memory:transactions-table-is-multi-tenant).
//
// Also the write path for transactions.contract_extraction /
// contract_extracted_at (added by the 2026-08-13 migration, unused by
// anything until now — the raw extraction is stored here unconditionally on
// every successful scan, term fields changed or not, as provenance: "when
// was this dossier's contract last read, and what did it say." The dedicated
// TERM_FIELD_MAP columns (closing_date, option_fee, etc.) remain the source
// of truth every other feature already reads; this is the audit trail behind
// them, not a second copy members are expected to read directly.
//
// Owner: Carter, 2026-09-21.

const { planContractTermWrites } = require('./contract-term-persistence');

const TERM_COLUMNS = [
  'contract_effective_date', 'closing_date', 'sale_price', 'earnest_money',
  'option_fee', 'option_days', 'financing_days', 'option_expiration_date',
  'possession_date', 'survey_deadline', 'loan_approval_deadline',
  'appraisal_deadline', 'hoa_document_deadline', 'commission_rate',
  'title_company', 'title_officer_name', 'title_officer_email', 'title_officer_phone',
];

const TERM_SELECT = [
  'id', 'user_id', 'property_address', 'contact_provenance',
  ...TERM_COLUMNS,
].join(',');

async function loadTransactionForTerms(sb, { userId, transactionId }) {
  if (!userId || !transactionId) return null;
  const { ok, data } = await sb(
    `transactions?select=${TERM_SELECT}`
    + `&id=eq.${encodeURIComponent(transactionId)}`
    + `&user_id=eq.${encodeURIComponent(userId)}`
    + '&limit=1',
  );
  if (!ok || !Array.isArray(data) || !data.length) return null;
  return data[0];
}

/**
 * Plan and (unless dryRun) apply the contract TERM fields from one scan.
 * Always returns the plan, including on a dry run — same contract as
 * persistContactsFromScan, for the same reason: reviewable before it writes.
 *
 * @param {Function} sb
 * @param {object}   opts
 * @param {string}   opts.userId
 * @param {string}   opts.transactionId
 * @param {object}   opts.extracted             `extracted` from scan-contract.js
 * @param {number}   [opts.documentTypeConfidence]
 * @param {object}   opts.source                 { document_id, file_name, document_label }
 * @param {string}   [opts.scanId]
 * @param {boolean}  [opts.dryRun]
 */
async function persistContractTermsFromScan(sb, {
  userId,
  transactionId,
  extracted,
  documentTypeConfidence = 1,
  source = {},
  scanId = null,
  dryRun = false,
}) {
  if (!extracted || typeof extracted !== 'object') {
    return { ok: false, reason: 'no_extraction', plan: null, written: false };
  }

  const tx = await loadTransactionForTerms(sb, { userId, transactionId });
  if (!tx) {
    return { ok: false, reason: 'deal_not_found_for_user', plan: null, written: false };
  }

  const plan = planContractTermWrites({ tx, extracted, documentTypeConfidence, source });

  if (dryRun) {
    return { ok: true, reason: 'dry_run', plan, written: false, transaction: tx };
  }

  const existingProv = tx.contact_provenance && typeof tx.contact_provenance === 'object' && !Array.isArray(tx.contact_provenance)
    ? tx.contact_provenance
    : {};

  const body = { ...plan.updates };
  // Provenance — always, regardless of whether any term field changed. This
  // is "we read this document on this date and here is everything we saw,"
  // not a mirror of the applied fields.
  body.contract_extraction = extracted;
  body.contract_extracted_at = new Date().toISOString();

  if (plan.conflicts.length) {
    const prevConflicts = Array.isArray(existingProv._conflicts) ? existingProv._conflicts : [];
    body.contact_provenance = {
      ...existingProv,
      _conflicts: [...prevConflicts, ...plan.conflicts.map((c) => ({ ...c, recorded_at: new Date().toISOString(), scan_id: scanId }))].slice(-50),
    };
  }

  const res = await sb(
    `transactions?id=eq.${encodeURIComponent(transactionId)}&user_id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    // Loud in the logs, silent to the member — the scan itself still
    // succeeded. memory:feedback_silent-failure-is-the-enemy: the alarm
    // ships with the change, not after it.
    console.error('[contract-term-persistence] PATCH failed', {
      status: res.status,
      transaction_id: transactionId,
      columns: Object.keys(body),
    });
    return { ok: false, reason: 'write_failed', status: res.status, plan, written: false, transaction: tx };
  }

  console.log('[contract-term-persistence]', JSON.stringify({
    transaction_id: transactionId,
    filled: plan.filled.map((f) => f.column),
    conflicts: plan.conflicts.length,
    skipped_low_confidence: plan.skippedLowConfidence.length,
  }));

  return { ok: true, reason: 'applied', plan, written: true, transaction: tx };
}

module.exports = { persistContractTermsFromScan, loadTransactionForTerms, TERM_COLUMNS };
