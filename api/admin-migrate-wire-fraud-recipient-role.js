// One-time migration: add wire_fraud_deliveries.recipient_role — see
// supabase/migrations/20260921_wire_fraud_deliveries_recipient_role.sql.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-21.

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.wire_fraud_deliveries
  ADD COLUMN IF NOT EXISTS recipient_role TEXT;

COMMENT ON COLUMN public.wire_fraud_deliveries.recipient_role IS
  'Which party this wire-fraud-warning delivery covers: buyer or seller. TAR/TXR 2517 applies to both. NULL on legacy rows written before this column existed.';
`;

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  try {
    await runAdminSql(SQL);
    return res.status(200).json({ ok: true, message: 'wire_fraud_deliveries.recipient_role added successfully' });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({ ok: false, error: 'Failed to add recipient_role', details: err.message });
  }
};
