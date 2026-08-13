-- Persist scan-contract.js's rich TREC paragraph-level extraction instead of
-- discarding it after one-time date-field prefill.
--
-- Root cause (Heath, 2026-08-12): api/scan-contract.js already reads
-- TREC paragraph-level detail (6.C survey responsibility, 10 fixtures, 11
-- special provisions, 12 expense splits, 22 addenda, financing terms) but
-- the result was only ever used to prefill a handful of date columns, then
-- thrown away — documents.scan_result stores just {form_name, field_count,
-- pages, cost}. Talk to Dossie's compactDealsForAction() only ever saw ~35
-- basic fields, so "who pays for the survey" got "I don't have that
-- recorded" even when the executed contract, already scanned, answered it.
--
-- Hybrid design: dedicated columns for the fields an agent actually asks
-- about in chat (queryable, small, safe to embed in every deal's compact
-- chat context) + one JSONB catch-all for the full extraction (no data
-- loss, future-proof, not sent to chat in full to avoid prompt bloat).

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS survey_payer TEXT,
  ADD COLUMN IF NOT EXISTS home_warranty_terms TEXT,
  ADD COLUMN IF NOT EXISTS repairs_summary TEXT,
  ADD COLUMN IF NOT EXISTS fixtures_included JSONB,
  ADD COLUMN IF NOT EXISTS fixtures_excluded JSONB,
  ADD COLUMN IF NOT EXISTS special_provisions TEXT,
  ADD COLUMN IF NOT EXISTS expense_allocation JSONB,
  ADD COLUMN IF NOT EXISTS prorations TEXT,
  ADD COLUMN IF NOT EXISTS addenda_attached JSONB,
  ADD COLUMN IF NOT EXISTS financing_terms JSONB,
  ADD COLUMN IF NOT EXISTS contract_extraction JSONB,
  ADD COLUMN IF NOT EXISTS contract_extracted_at TIMESTAMPTZ;

COMMENT ON COLUMN transactions.survey_payer IS 'Who is responsible for / pays for the survey per TREC ¶6.C — verbatim text of whichever checkbox option is checked. Derived deterministically in scan-contract.js from debugParagraph6C, same pattern as survey_deadline.';
COMMENT ON COLUMN transactions.home_warranty_terms IS 'Residential service contract / home warranty terms from ¶7, if present. Free text summary.';
COMMENT ON COLUMN transactions.repairs_summary IS 'Negotiated repair commitments found in the contract (special provisions or repair amendment). Free text summary.';
COMMENT ON COLUMN transactions.fixtures_included IS 'Write-in items added to ¶10 inclusions beyond the TREC standard list. JSON array of strings.';
COMMENT ON COLUMN transactions.fixtures_excluded IS 'Items explicitly excluded from the sale per ¶10. JSON array of strings.';
COMMENT ON COLUMN transactions.special_provisions IS 'Verbatim ¶11 Special Provisions text.';
COMMENT ON COLUMN transactions.expense_allocation IS 'Paragraph 12 buyer/seller expense split — {sellerPaysAmount, sellerPaysPercentage, buyerPaysClosingCosts}.';
COMMENT ON COLUMN transactions.prorations IS 'Paragraph 13 proration terms, only populated when non-standard/customized.';
COMMENT ON COLUMN transactions.addenda_attached IS 'Readable list of addenda checked in ¶22 and actually attached to this contract. JSON array of strings.';
COMMENT ON COLUMN transactions.financing_terms IS 'Financing summary — lender, financing days, loan approval deadline — pulled from the executed contract/addendum.';
COMMENT ON COLUMN transactions.contract_extraction IS 'Full structured extraction object from scan-contract.js for the most recently scanned TREC 20-17 on this dossier. Catch-all so nothing the AI already read is ever lost, even fields with no dedicated column yet.';
COMMENT ON COLUMN transactions.contract_extracted_at IS 'When contract_extraction was last written. NULL means this dossier has never had a contract successfully scanned — chat should say so honestly rather than imply the data does not exist.';
