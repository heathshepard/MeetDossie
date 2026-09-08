// One-time migration: multi-document packet + audit-trail columns on
// public.signature_requests. Canonical SQL + column commentary:
// api/_migrations/0026-esign-packets-audit.sql.
//
// Safe to re-run — ADD COLUMN IF NOT EXISTS only. No data is touched.
//
// Exists for the same reason as its admin-migrate-* siblings:
// POSTGRES_URL_NON_POOLING is a write-only ("Sensitive") Vercel var, so DDL
// cannot be run from a local shell.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-08 (DossieSign multi-document packets)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.signature_requests
  ADD COLUMN IF NOT EXISTS document_ids          JSONB,
  ADD COLUMN IF NOT EXISTS sent_pdf_sha256       JSONB,
  ADD COLUMN IF NOT EXISTS signed_pdf_sha256     JSONB,
  ADD COLUMN IF NOT EXISTS audit_log_sha256      TEXT,
  ADD COLUMN IF NOT EXISTS audit_log_document_id UUID REFERENCES public.documents(id),
  ADD COLUMN IF NOT EXISTS submission_events     JSONB,
  ADD COLUMN IF NOT EXISTS docuseal_template_id  TEXT,
  ADD COLUMN IF NOT EXISTS audit_fetch_failed_at TIMESTAMPTZ;
`;

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader =
    (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(SQL);
    return res.status(200).json({
      ok: true,
      message: 'signature_requests packet + audit-trail columns added (or already existed)',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to add signature_requests packet/audit columns',
      details: err.message,
    });
  }
};
