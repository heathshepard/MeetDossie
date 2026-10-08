// One-time migration: add outbound_email_queue.kind / user_id /
// transaction_id / to_name / from_display_name so member transaction email
// (api/send-email.js) can log into this table instead of the dead-end
// email_queue table.
//
// Run this ONCE manually (on staging first), then this file can stay —
// every statement is idempotent (ADD COLUMN IF NOT EXISTS).
// Mirrors the SQL tracked at
// supabase/migrations/20261008_outbound_email_queue_member_fields.sql.
//
// RUN THIS BEFORE deploying the send-email.js change that writes
// kind='member_transaction' rows — that write 400s until these columns
// exist (PostgREST rejects unknown columns the same way described in
// cron-deadline-reminders.js's SELECT_OPTIONAL history).
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: 2026-10-08 (email_queue -> outbound_email_queue migration)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.outbound_email_queue
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'cold_outreach';

ALTER TABLE public.outbound_email_queue
  ADD COLUMN IF NOT EXISTS user_id UUID;

ALTER TABLE public.outbound_email_queue
  ADD COLUMN IF NOT EXISTS transaction_id TEXT;

ALTER TABLE public.outbound_email_queue
  ADD COLUMN IF NOT EXISTS to_name TEXT;

ALTER TABLE public.outbound_email_queue
  ADD COLUMN IF NOT EXISTS from_display_name TEXT;

COMMENT ON COLUMN public.outbound_email_queue.kind IS
  'Row class, drives sender identity in sendOutboundEmailRow(). "cold_outreach" (default, existing behavior, unchanged) = Heath-branded, BCC heath@meetdossie.com. "member_transaction" (new, 2026-10-08) = {from_display_name} via Dossie <dossie@meetdossie.com>, no BCC (customer-file operational email).';
COMMENT ON COLUMN public.outbound_email_queue.user_id IS
  'Member/agent owner for a member_transaction row. NULL on cold_outreach rows (those are Heath''s own, not member-scoped).';
COMMENT ON COLUMN public.outbound_email_queue.transaction_id IS
  'Dossier this email belongs to, for member_transaction rows (text, matches transactions.id serialized). NULL on cold_outreach rows.';
COMMENT ON COLUMN public.outbound_email_queue.to_name IS
  'Recipient display name for member_transaction rows (e.g. the buyer/seller name). Optional, display-only.';
COMMENT ON COLUMN public.outbound_email_queue.from_display_name IS
  'Agent''s own name for member_transaction rows, rendered as "{from_display_name} via Dossie". NULL falls back to plain "Dossie".';

CREATE INDEX IF NOT EXISTS idx_outbound_email_queue_kind_user
  ON public.outbound_email_queue (kind, user_id);
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
      message: 'outbound_email_queue.kind/user_id/transaction_id/to_name/from_display_name ready',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({ ok: false, error: 'Failed to add outbound_email_queue member fields', details: err.message });
  }
};
