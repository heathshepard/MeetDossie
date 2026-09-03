// One-time migration: add option_fee_due_date / earnest_money_due_date
// columns to public.transactions (TREC ¶5.A funds delivery deadlines).
// Run this ONCE manually, then delete. No schedule needed.
// Mirrors the SQL tracked at
// supabase/migrations/20260903_transactions_funds_delivery_due_dates.sql.
//
// Safe to re-run: ADD COLUMN IF NOT EXISTS is a no-op on a second run.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-03 (Deadline Guardian checklist #1)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS option_fee_due_date DATE;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS earnest_money_due_date DATE;

COMMENT ON COLUMN public.transactions.option_fee_due_date IS
  'TREC ¶5.A option fee delivery deadline: contract_effective_date + 3 calendar days, then ¶5A(2) weekend/Texas Legal Holiday rollover. Computed by api/_lib/business-calendar.js; NULL means never computed (no effective date, or row predates the column).';
COMMENT ON COLUMN public.transactions.earnest_money_due_date IS
  'TREC ¶5.A earnest money delivery deadline: contract_effective_date + 3 calendar days, then ¶5A(2) weekend/Texas Legal Holiday rollover. Computed by api/_lib/business-calendar.js; NULL means never computed (no effective date, or row predates the column).';
`;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(SQL);
    return res.status(200).json({
      ok: true,
      message: 'transactions.option_fee_due_date / earnest_money_due_date columns ready',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({ ok: false, error: 'Failed to add funds delivery due date columns', details: err.message });
  }
};
