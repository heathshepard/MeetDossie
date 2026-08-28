// One-time migration: create public.comment_watchlist (unified thread
// watchlist for Sage's comment-opportunity + reply-monitoring pipeline).
// Safe to re-run -- CREATE TABLE/INDEX IF NOT EXISTS throughout, no data
// touched.
//
// DDL isn't reachable through PostgREST, so this runs directly against
// Postgres via api/_lib/pg-admin.js (POSTGRES_URL_NON_POOLING). Mirrors
// supabase/migrations/20260828_comment_watchlist.sql and the exact pattern
// of api/admin-migrate-engagement-queue.js.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Sage, 2026-08-28

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
CREATE TABLE IF NOT EXISTS public.comment_watchlist (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_url            TEXT NOT NULL,
  group_name            TEXT,
  post_author           TEXT,
  direction             TEXT NOT NULL
                        CHECK (direction IN ('heath_commented_on_others', 'heath_own_post')),
  our_text              TEXT,
  source_table          TEXT NOT NULL
                        CHECK (source_table IN ('engagement_queue', 'group_posts')),
  source_id             UUID,
  posted_at             TIMESTAMPTZ NOT NULL,
  status                TEXT NOT NULL DEFAULT 'watching'
                        CHECK (status IN ('watching', 'reply_detected', 'stale', 'archived')),
  last_checked_at       TIMESTAMPTZ,
  reply_detected_at     TIMESTAMPTZ,
  reply_author          TEXT,
  reply_text            TEXT,
  proposed_response     TEXT,
  heath_responded_at    TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comment_watchlist_status
  ON public.comment_watchlist (status, last_checked_at);

CREATE INDEX IF NOT EXISTS idx_comment_watchlist_source
  ON public.comment_watchlist (source_table, source_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_watchlist_source_unique
  ON public.comment_watchlist (source_table, source_id)
  WHERE source_id IS NOT NULL;

ALTER TABLE public.comment_watchlist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS comment_watchlist_service_all ON public.comment_watchlist;
CREATE POLICY comment_watchlist_service_all ON public.comment_watchlist
  FOR ALL USING (true) WITH CHECK (true);
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
      message: 'comment_watchlist table + indexes created successfully',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to create comment_watchlist',
      detail: err.message,
    });
  }
};
