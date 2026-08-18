// One-time migration: add last_post_error column to public.engagement_queue.
// Safe to re-run -- ADD COLUMN IF NOT EXISTS, no data touched.
//
// scripts/sage-engagement-queue-poster.js's markFailed() already writes this
// column on post-attempt failure but the column didn't exist, so the write
// failed silently (non-fatal) and errors went unlogged.
//
// DDL isn't reachable through PostgREST, so this runs directly against
// Postgres via api/_lib/pg-admin.js (POSTGRES_URL_NON_POOLING). Mirrors
// supabase/migrations/20260817_engagement_queue_last_post_error.sql and the
// exact pattern of api/admin-migrate-engagement-queue.js.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-08-17

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.engagement_queue
  ADD COLUMN IF NOT EXISTS last_post_error TEXT;

COMMENT ON COLUMN public.engagement_queue.last_post_error IS
  'Most recent post-attempt failure reason, written by scripts/sage-engagement-queue-poster.js markFailed(). Row stays status=approved so it retries; this is for visibility only.';
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
      message: 'engagement_queue.last_post_error column added successfully',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to add last_post_error column',
      details: err.message,
    });
  }
};
