// api/_lib/required-documents.js
//
// Real, generalized required-documents watchlist — the source of truth for
// "which document types does Dossie know how to chase." Built 2026-08-25 to
// close the gap Atlas's infra audit flagged: api/cron-followup.js used to
// hard-code only 7 document types (IABS, Seller's Disclosure, buyer rep,
// title commitment, survey, pre-approval, HOA docs). Any action item
// referencing a document type outside that list of 7 fell through to the
// generic client-facing follow-up path with NO verification against the
// documents table first — meaning it could auto-send a "please send this
// over" nag straight to the client at 48h with zero check that the document
// was already on file, and zero human review. That is exactly the false-
// positive class this file's header already warned about for IABS
// (2026-08-10 104 Wild Cherry incident) — just not closed for every type.
//
// Ported from Dossie/dossie-app.jsx's getRequiredDocs() + DOC_TYPE_TO_CHECKLIST
// (the client-side "what's required for this deal" logic), cross-checked
// against the real document_type enum in api/scan-contract.js's
// DOCUMENT_LABELS so every `documentType` value below is a type the scanner
// actually produces — never a guessed name.
//
// Deliberately excludes two getRequiredDocs() line items that have no
// matching scan-contract.js document_type:
//   - "groundwater-notice" (Groundwater and Surface Water Rights Disclosure)
//   - "onsite-sewer" when treated as a plain disclosure line (the scanner's
//     equivalent, onsite-sewer-form, IS included below)
// Per the standing rule already documented in this file's history: a doc
// type is left off rather than guessing a flag/type that doesn't exist.
//
// NOTE: this is intentionally narrower than getRequiredDocs() itself — it
// does not encode deal-shape applicability (financing/HOA/lead-paint
// conditionals, buyer-vs-listing branching). cron-followup.js only reacts to
// action_items that already exist and already reference a specific document
// by name/description; it never invents new required-doc obligations for a
// transaction. Applicability was already decided by whatever created the
// action item. Encoding the full conditional rule set here would duplicate
// getRequiredDocs() across two repos for no behavioral gain at this call
// site — exactly the over-engineering CLAUDE.md warns against.

const REQUIRED_DOCUMENT_WATCHLIST = [
  // ── Original 7 (unchanged from the pre-2026-08-25 hard-coded list) ──────
  {
    id: 'iabs',
    match: /\biabs\b|information about brokerage services/i,
    transactionFlag: 'iabs_delivered_at',
    documentType: 'iabs-form',
    label: 'IABS',
  },
  {
    id: 'sellers-disclosure',
    match: /seller'?s?\s+disclosure|\bsdn\b/i,
    transactionFlag: 'sellers_disclosure_received_at',
    documentType: 'trec-sellers-disclosure',
    label: "Seller's Disclosure Notice",
  },
  {
    id: 'buyer-representation',
    match: /buyer representation/i,
    transactionFlag: 'buyer_rep_signed_at',
    documentType: 'trec-buyer-representation',
    label: 'Buyer Representation Agreement',
  },
  {
    id: 'title-commitment',
    match: /title commitment/i,
    transactionFlag: 'title_commitment_received_at',
    documentType: 'title-commitment',
    label: 'Title Commitment',
  },
  {
    id: 'survey',
    match: /\bsurvey\b/i,
    transactionFlag: 'survey_received_at',
    documentType: 'survey',
    label: 'Survey',
  },
  {
    id: 'pre-approval',
    match: /pre-?approval/i,
    transactionFlag: 'pre_approval_received',
    documentType: 'pre-approval-letter',
    label: 'Pre-Approval Letter',
  },
  {
    id: 'hoa-docs',
    match: /\bhoa\b.*(docs|documents|addendum)/i,
    transactionFlag: 'hoa_docs_received_at',
    documentType: 'trec-hoa-addendum',
    label: 'HOA Documents',
  },

  // ── New 2026-08-25 — real getRequiredDocs() entries with no known
  // transaction-level delivery flag column, so resolution checks the
  // documents table only (still correct: checkDocumentFollowupResolved
  // treats a missing flag as "not set" rather than failing). ──────────────
  {
    id: 'lead-paint',
    match: /lead[- ]?(based)?[- ]?paint/i,
    transactionFlag: null,
    documentType: 'trec-lead-paint',
    label: 'Lead Paint Disclosure',
  },
  {
    id: 'onsite-sewer',
    match: /on-?site sewer|septic (facility|disclosure|information|system)/i,
    transactionFlag: null,
    documentType: 'onsite-sewer-form',
    label: 'On-Site Sewer Facility Information',
  },
  {
    id: 'executed-contract',
    match: /executed (purchase )?contract|signed (purchase )?contract|one to four family residential contract/i,
    transactionFlag: null,
    documentType: 'trec-20-17',
    label: 'Executed Contract',
  },
  {
    id: 'third-party-financing',
    match: /third[- ]party financing addendum/i,
    transactionFlag: null,
    documentType: 'trec-financing-addendum',
    label: 'Third Party Financing Addendum',
  },
  {
    id: 'closing-disclosure',
    match: /closing disclosure/i,
    transactionFlag: null,
    documentType: 'closing-disclosure',
    label: 'Closing Disclosure',
  },
  {
    id: 'wire-fraud-warning',
    match: /wire fraud warning/i,
    transactionFlag: null,
    documentType: 'wire-fraud-warning',
    label: 'Wire Fraud Warning',
  },
  {
    id: 'wire-instructions',
    match: /wire instructions/i,
    transactionFlag: null,
    documentType: 'wire-instructions',
    label: 'Wire Instructions',
  },
  {
    id: 'general-info-notice',
    match: /general information (and notice|notice) to consumers|general info(rmation)? notice/i,
    transactionFlag: null,
    documentType: 'general-info-notice',
    label: 'General Information and Notice to Consumers',
  },
  {
    id: 'listing-agreement',
    match: /listing agreement|exclusive right to sell/i,
    transactionFlag: null,
    documentType: 'trec-listing-agreement',
    label: 'Listing Agreement',
  },
];

module.exports = { REQUIRED_DOCUMENT_WATCHLIST };
