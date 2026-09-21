'use strict';

// api/_lib/contract-term-persistence.js
//
// Turn a contract scan's TERM fields (dates, dollar amounts, deadlines) into
// a plan Dossie can act on. Mirrors api/_lib/contact-persistence.js — same
// problem (scan-contract.js has read this for months; something has to write
// it down), same Rule 1: A HUMAN VALUE ALWAYS WINS. We only ever fill a
// column that is empty. When a parsed value disagrees with a value already
// on the record, we do NOT resolve it — we record a conflict and leave the
// existing value alone.
//
// Deliberately feeds the SAME contact_provenance._conflicts ledger
// contact-persistence-store.js writes to (see that file's K_CONFLICTS), so a
// term conflict ("contract says closing 10/22, dossier has 10/15") surfaces
// through the EXISTING inconsistency-flow UI (InconsistencyCard) with no new
// component and no new "which card is this" question for the member.
// inconsistency-flow.js's OPERATIVE_COLUMNS already lists closing_date,
// sale_price, earnest_money, option_fee, option_days, contract_effective_date
// and possession_date by name — this module is the missing producer for
// that consumer, not a new concept.
//
// Deliberately excludes anything that records a PAYMENT EVENT (earnest money
// DEPOSITED, option fee PAID, EM confirmed by title). Those are proof-of-an-
// action-happening fields, gated behind DocuSeal signature verification in
// dossie-app.jsx's handleUploadDocument (a stricter, different claim than
// "the contract states this amount is owed") — left alone here on purpose,
// not duplicated.
//
// PURE: no fetch, no Supabase, no Date.now() not passed in. The I/O half is
// contract-term-persistence-store.js. Same reasoning as contact-persistence.js
// — testable against a real extraction without touching a real deal.
//
// Owner: Carter, 2026-09-21.

// [transactions column, how to read it off `extracted`, human label, numeric?]
// Deliberately the SAME field set dossie-app.jsx's handleUploadDocument
// directMap already writes on the general-upload path (so a contract that
// arrives by email or by chat request ends up with the identical set of
// fields a drag-and-drop upload would have filled) minus the payment-EVENT
// fields noted above.
const TERM_FIELD_MAP = [
  { column: 'contract_effective_date', get: (ef) => ef.listingStartDate || ef.contractEffectiveDate, label: 'Effective date' },
  { column: 'closing_date', get: (ef) => ef.closingDate, label: 'Closing date' },
  { column: 'sale_price', get: (ef) => (ef.listPrice ?? ef.salePrice), label: 'Sale price', numeric: true },
  { column: 'earnest_money', get: (ef) => ef.earnestMoney, label: 'Earnest money', numeric: true },
  { column: 'option_fee', get: (ef) => ef.optionFee, label: 'Option fee', numeric: true },
  { column: 'option_days', get: (ef) => ef.optionDays, label: 'Option period (days)', numeric: true },
  { column: 'financing_days', get: (ef) => ef.financingDays, label: 'Financing days', numeric: true },
  { column: 'option_expiration_date', get: (ef) => ef.optionExpirationDate, label: 'Option period expiration' },
  { column: 'possession_date', get: (ef) => ef.possessionDate, label: 'Possession date' },
  { column: 'survey_deadline', get: (ef) => ef.surveyDeadline, label: 'Survey deadline' },
  { column: 'loan_approval_deadline', get: (ef) => ef.loanApprovalDeadline, label: 'Loan approval deadline' },
  { column: 'appraisal_deadline', get: (ef) => ef.appraisalDeadline, label: 'Appraisal deadline' },
  { column: 'hoa_document_deadline', get: (ef) => ef.hoaDocumentDeadline, label: 'HOA document deadline' },
  { column: 'commission_rate', get: (ef) => ef.commissionRate, label: 'Commission rate' },
  { column: 'title_company', get: (ef) => ef.titleCompany, label: 'Title company' },
  { column: 'title_officer_name', get: (ef) => ef.titleOfficerName, label: 'Title officer' },
  { column: 'title_officer_email', get: (ef) => ef.titleOfficerEmail, label: 'Title officer email' },
  { column: 'title_officer_phone', get: (ef) => ef.titleOfficerPhone, label: 'Title officer phone' },
];

const CONFIDENCE_MIN = 0.70;

// A numeric term of exactly 0 is indistinguishable from "never set" on this
// schema (dossie-app.jsx's own directMap relies on the same `> 0` convention)
// — treated as blank, not as a real zero-dollar/zero-day term.
function isBlank(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v === 'number') return !Number.isFinite(v) || v === 0;
  return false;
}

function normNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sameValue(a, b) {
  if (a == null || b == null) return false;
  const na = normNumber(a);
  const nb = normNumber(b);
  if (na != null && nb != null) return na === nb;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * @param {object} tx        current transaction row (snake_case columns)
 * @param {object} extracted scan-contract.js's `extracted`
 * @param {number} documentTypeConfidence  0..1, the classifier's confidence
 *   this document IS the contract. scan-contract.js's per-field `confidence`
 *   map is populated only rarely in practice (matches dossie-app.jsx's own
 *   handleUploadDocument, which already falls back to this same overall
 *   score for every field when no per-field score exists).
 * @param {object} source    { document_id, file_name, document_label }
 */
function planContractTermWrites({ tx, extracted, documentTypeConfidence = 1, source = {} }) {
  const row = tx && typeof tx === 'object' ? tx : {};
  const ef = extracted && typeof extracted === 'object' ? extracted : {};
  const updates = {};
  const filled = [];
  const conflicts = [];
  const skippedLowConfidence = [];

  if (documentTypeConfidence < CONFIDENCE_MIN) {
    return { updates, filled, conflicts, skippedLowConfidence: TERM_FIELD_MAP.map((f) => f.column) };
  }

  for (const field of TERM_FIELD_MAP) {
    let raw = field.get(ef);
    if (raw === undefined || raw === null) continue;
    if (field.numeric) {
      raw = normNumber(raw);
      if (raw === null || raw <= 0) continue;
    } else {
      raw = String(raw).trim();
      if (!raw) continue;
    }

    const existing = row[field.column];
    if (!isBlank(existing)) {
      if (!sameValue(existing, raw)) {
        conflicts.push({
          column: field.column,
          existing: String(existing),
          parsed: String(raw),
          source_field: field.column,
          document: source,
          detail: `The contract says ${field.label.toLowerCase()} is ${raw}, but the dossier already has ${existing}. Kept what was on the dossier.`,
        });
      }
      continue;
    }

    updates[field.column] = raw;
    filled.push({ column: field.column, value: raw, label: field.label });
  }

  return { updates, filled, conflicts, skippedLowConfidence };
}

module.exports = { planContractTermWrites, TERM_FIELD_MAP, CONFIDENCE_MIN };
