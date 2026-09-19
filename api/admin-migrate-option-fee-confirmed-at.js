// One-time migration: add transactions.option_fee_confirmed_at (TREC ¶5.A
// option fee CONFIRMED RECEIPT) and document the sent-vs-received split on the
// four ¶5.A funds columns.
//
// Run this ONCE manually, then delete. No schedule needed.
// Mirrors the SQL tracked at
// supabase/migrations/20260917e_transactions_option_fee_confirmed_at.sql.
//
// RUN THIS BEFORE (or immediately after) deploying the cron-deadline-reminders
// change that suppresses on option_fee_confirmed_at. The cron degrades safely
// if the column is missing — it drops it from the select and keeps reminding —
// but it cannot suppress until this has run.
//
// Safe to re-run: ADD COLUMN IF NOT EXISTS is a no-op on a second run.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: 2026-09-17 (Deadline Guardian Gate 6 — confirmed receipt, not assumed)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS option_fee_confirmed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.transactions.option_fee_confirmed_at IS
  'TREC ¶5.A option fee CONFIRMED RECEIPT: the escrow agent/title company acknowledged receiving the funds. The only field that may suppress the option-fee delivery reminder in cron-deadline-reminders.js. NULL means not confirmed — remind.';

COMMENT ON COLUMN public.transactions.option_fee_paid_at IS
  'SELF-REPORTED "option fee paid" marker. Auto-stamped with the upload time when an executed contract is scanned and ¶5.A shows any option fee amount, and hand-editable in the workspace. NOT proof of receipt — never use it to suppress a delivery reminder. Use option_fee_confirmed_at.';

COMMENT ON COLUMN public.transactions.earnest_money_deposited_at IS
  'SELF-REPORTED "earnest money deposited/sent" marker. Auto-stamped with the upload time when an executed contract is scanned and ¶5.A shows any earnest money amount, and hand-editable in the workspace. NOT proof of receipt — never use it to suppress a delivery reminder. Use earnest_money_confirmed_at.';

COMMENT ON COLUMN public.transactions.earnest_money_confirmed_at IS
  'TREC ¶5.A earnest money CONFIRMED RECEIPT: written from the page-11 escrow receipt block of the executed contract, or set explicitly when title confirms. The only field that may suppress the earnest-money delivery reminder. NULL means not confirmed — remind.';
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
      message: 'transactions.option_fee_confirmed_at ready; ¶5.A sent-vs-received comments applied',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({ ok: false, error: 'Failed to add option_fee_confirmed_at column', details: err.message });
  }
};
