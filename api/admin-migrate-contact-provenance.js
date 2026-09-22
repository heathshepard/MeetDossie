// One-time migration: add transactions.contact_provenance.
//
// Contact details parsed off a contract are a CLAIM, not a fact.
// memory:acroform-field-names-lie records 22+ mismapped TREC fields in this
// codebase — including a checkbox that silently made a false legal attestation
// — so a value Dossie read off a PDF must never be indistinguishable from one
// the member typed. This column is what keeps them distinguishable.
//
// Shape, keyed by the transactions column the value was written to:
//
//   {
//     "other_agent_email_addr": {
//       "value": "dwhitaker@riverbendrealty.example",
//       "source_field": "parties.buyerAgentEmail",
//       "source_block": "BROKER CONTACT INFORMATION",
//       "document_id": "…", "file_name": "…contract.pdf",
//       "document_label": "Residential contract",
//       "scan_id": "…", "extracted_at": "2026-09-20T…", "origin": "contract_scan"
//     },
//     "_conflicts": [ { column, existing, parsed, detail, recorded_at }, … ]
//   }
//
// Two things follow from it. A wrong address is traceable to the page it came
// off instead of looking like member input. And the absence of an entry is
// itself meaningful: a column with no provenance row was typed by a person,
// and api/_lib/contact-persistence.js will never overwrite it.
//
// `_conflicts` holds the cases where a parsed value DISAGREED with something
// already on the dossier. Those are deliberately not applied — the member's
// value wins — but they are kept, because "the contract says a different
// spelling of your seller's name" is worth being able to show them later.
//
// Safe to re-run — IF NOT EXISTS.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: 2026-09-20 (contract-scan contact persistence)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS contact_provenance JSONB;

COMMENT ON COLUMN transactions.contact_provenance IS 'Where each machine-parsed contact value came from, keyed by the transactions column it was written to: source document, source field, source block on the form, scan id and timestamp. A column WITHOUT an entry here was entered by a human and outranks anything parsed. Reserved key _conflicts holds parsed values that disagreed with existing data and were therefore NOT applied. Written by api/_lib/contact-persistence-store.js.';
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
      message: 'contact_provenance column added to transactions successfully',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to add contact_provenance column',
      details: err.message,
    });
  }
};
