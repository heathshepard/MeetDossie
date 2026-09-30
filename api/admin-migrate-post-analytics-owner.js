// One-time migration: add owner/account_handle/video_library_id to
// public.post_analytics so a personal-account (heath-realtor) post's
// engagement can be told apart from a brand (dossie) post's, and so a
// video_library (Pipeline B) post can land a row here at all -- it never
// could before (post_analytics.social_post_id is a hard FK to social_posts
// only). See supabase/migrations/20260930_post_analytics_owner_attribution.sql
// for the full rationale. Safe to re-run -- every clause is
// IF NOT EXISTS / idempotent, no data destroyed, no existing row's
// owner/account_handle/video_library_id values are touched by a re-run.
//
// NOT INVOKED as part of this branch/PR — this changes the live production
// database immediately regardless of git branch/merge state (unlike a
// Vercel deploy), so it is left for Heath to trigger deliberately:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://meetdossie.com/api/admin-migrate-post-analytics-owner
//
// DDL isn't reachable through PostgREST (no generic SQL-exec RPC deployed on
// this project), so this runs directly against Postgres via the shared
// api/_lib/pg-admin.js helper (POSTGRES_URL_NON_POOLING) — same pattern as
// api/admin-migrate-zernio-page-id.js.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-09-30

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.post_analytics
  ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT 'dossie',
  ADD COLUMN IF NOT EXISTS account_handle TEXT,
  ADD COLUMN IF NOT EXISTS video_library_id TEXT REFERENCES public.video_library(id) ON DELETE CASCADE;

ALTER TABLE public.post_analytics
  DROP CONSTRAINT IF EXISTS post_analytics_exactly_one_source;
ALTER TABLE public.post_analytics
  ADD CONSTRAINT post_analytics_exactly_one_source
  CHECK (num_nonnulls(social_post_id, video_library_id) = 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_post_analytics_video_per_day
  ON public.post_analytics (video_library_id, sync_date)
  WHERE video_library_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_post_analytics_owner
  ON public.post_analytics (owner, fetched_at DESC);
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
      message: 'post_analytics.owner/account_handle/video_library_id added, exactly-one-source constraint + indexes created',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to migrate post_analytics owner attribution',
      details: err.message,
    });
  }
};
