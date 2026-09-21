// One-time migration: add transactions.archived_at + transaction_offers.archived_at
// — see supabase/migrations/20260921_transactions_and_offers_archive.sql for
// full commentary. Safe to re-run — IF NOT EXISTS / CREATE INDEX IF NOT
// EXISTS throughout.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-21 (hard-delete sibling audit fix, priority 1).

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

COMMENT ON COLUMN public.transactions.archived_at IS
  'When this dossier was archived (soft-deleted). NULL = active/visible. Set by DELETE /api/transactions, which stopped hard-deleting the row (and cascading to its documents/action_items/email_queue/signature_requests/amendments/wire_fraud_deliveries/deadline_reminders/transaction_offers) on 2026-09-21 -- archiving is the only "delete" path now.';

CREATE INDEX IF NOT EXISTS transactions_archived_at_idx ON public.transactions (archived_at);

ALTER TABLE public.transaction_offers
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

COMMENT ON COLUMN public.transaction_offers.archived_at IS
  'When this offer-comparison row was archived (soft-deleted) by the member removing it from the table. NULL = active/visible. Distinct from the offers-model "retired" status -- a live business-state transition tracked separately, not a member delete action.';

CREATE INDEX IF NOT EXISTS transaction_offers_archived_at_idx ON public.transaction_offers (archived_at);
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
      message: 'transactions.archived_at + transaction_offers.archived_at added successfully',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to add archived_at columns',
      details: err.message,
    });
  }
};
