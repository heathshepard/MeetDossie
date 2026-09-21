// One-time migration: add documents.executed_at — see
// supabase/migrations/20260921_documents_executed_at.sql for full
// commentary. Safe to re-run.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-21.

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.documents.executed_at IS
  'When this row was filed as the completed/executed copy of a document sent for e-signature. NULL = not an e-sign-pipeline copy.';

CREATE INDEX IF NOT EXISTS documents_executed_at_idx ON public.documents (executed_at);
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
    return res.status(200).json({ ok: true, message: 'documents.executed_at added successfully' });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to add documents.executed_at',
      details: err.message,
    });
  }
};
