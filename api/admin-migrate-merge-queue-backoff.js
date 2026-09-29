// One-time migration: add next_check_after + check_count to
// public.merge_queue, for the cron-merge-queue-backfill backoff fix.
// Safe to re-run -- ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
// throughout, no data touched.
//
// DDL isn't reachable through PostgREST, so this runs directly against
// Postgres via api/_lib/pg-admin.js (POSTGRES_URL_NON_POOLING). Mirrors
// supabase/migrations/20260929_merge_queue_backoff.sql and the exact pattern
// of api/admin-migrate-comment-watchlist.js.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-09-29

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.merge_queue
  ADD COLUMN IF NOT EXISTS next_check_after TIMESTAMPTZ;

ALTER TABLE public.merge_queue
  ADD COLUMN IF NOT EXISTS check_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_merge_queue_pending_backoff
  ON public.merge_queue (merged_to_main, next_check_after)
  WHERE merged_to_main = false;
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
      message: 'merge_queue.next_check_after + check_count created successfully',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to add merge_queue backoff columns',
      detail: err.message,
    });
  }
};
