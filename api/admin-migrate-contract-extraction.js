// One-time migration: add survey_payer / home_warranty_terms /
// repairs_summary / fixtures_included / fixtures_excluded /
// special_provisions / expense_allocation / prorations / addenda_attached /
// financing_terms / contract_extraction / contract_extracted_at columns to
// public.transactions — see
// supabase/migrations/20260813_contract_extraction_persistence.sql for full
// commentary. Safe to re-run — every statement is IF NOT EXISTS.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-08-13 (Talk to Dossie contract-extraction persistence)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
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
`;

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(SQL);
    return res.status(200).json({
      ok: true,
      message: 'contract-extraction columns added to transactions successfully',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to add contract-extraction columns',
      details: err.message,
    });
  }
};
