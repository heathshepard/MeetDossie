// One-time migration: add nullable-with-default target_owner column to
// public.video_library (see supabase/migrations/20260910_video_library_target_owner.sql
// for full rationale — weekly recording kit GAP 4).
//
// DDL isn't reachable through PostgREST (no generic SQL-exec RPC deployed on
// this project), so this runs directly against Postgres via the shared
// api/_lib/pg-admin.js helper (POSTGRES_URL_NON_POOLING), same pattern as
// api/admin-migrate-zernio-page-id.js.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-10

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.video_library
  ADD COLUMN IF NOT EXISTS target_owner text NOT NULL DEFAULT 'dossie';

ALTER TABLE public.video_library
  DROP CONSTRAINT IF EXISTS video_library_target_owner_check;

ALTER TABLE public.video_library
  ADD CONSTRAINT video_library_target_owner_check
  CHECK (target_owner IN ('dossie', 'heath-realtor'));

CREATE INDEX IF NOT EXISTS idx_video_library_target_owner
  ON public.video_library (target_owner)
  WHERE target_owner <> 'dossie';
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
      message: 'video_library.target_owner column added (default dossie, check constraint dossie|heath-realtor)',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to migrate video_library.target_owner',
      details: err.message,
    });
  }
};
