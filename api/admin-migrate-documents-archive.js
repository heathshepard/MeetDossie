// One-time migration: add documents.archived_at — see
// supabase/migrations/20260921_documents_archive.sql for full commentary.
// Safe to re-run — IF NOT EXISTS / CREATE INDEX IF NOT EXISTS throughout.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-21 (document/offer model, item 2 — bulk archive).

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

COMMENT ON COLUMN public.documents.archived_at IS
  'When this document was archived (soft-deleted). NULL = active/visible. Set by DELETE /api/documents, which stopped removing rows/Storage objects on 2026-09-21 -- archiving is the only "delete" path now. The Storage object and the row are never removed by member action.';

CREATE INDEX IF NOT EXISTS documents_archived_at_idx ON public.documents (archived_at);
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
      message: 'documents.archived_at added successfully',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to add documents.archived_at',
      details: err.message,
    });
  }
};
