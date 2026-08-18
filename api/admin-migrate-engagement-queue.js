// One-time migration: create public.engagement_queue (FB-group engagement
// draft review table). Safe to re-run -- CREATE TABLE/INDEX IF NOT EXISTS
// throughout, no data touched.
//
// DDL isn't reachable through PostgREST, so this runs directly against
// Postgres via api/_lib/pg-admin.js (POSTGRES_URL_NON_POOLING). Mirrors
// supabase/migrations/20260817_engagement_queue.sql and the exact pattern of
// api/admin-migrate-content-pipeline-queue.js.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Sage, 2026-08-17

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
CREATE TABLE IF NOT EXISTS public.engagement_queue (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source                TEXT NOT NULL DEFAULT 'facebook_group',
  group_name            TEXT NOT NULL,
  group_url             TEXT,
  content_type          TEXT NOT NULL DEFAULT 'post'
                        CHECK (content_type IN ('post', 'comment')),
  author_name           TEXT,
  original_text         TEXT NOT NULL,
  thread_context        TEXT,
  permalink             TEXT,
  matched_pattern       TEXT,
  drafted_reply         TEXT NOT NULL,
  draft_model            TEXT,
  status                TEXT NOT NULL DEFAULT 'pending_review'
                        CHECK (status IN (
                          'pending_review', 'approved', 'rejected',
                          'posted', 'expired'
                        )),
  telegram_sent_at      TIMESTAMPTZ,
  telegram_message_id   BIGINT,
  reviewed_at           TIMESTAMPTZ,
  posted_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_name, original_text)
);

CREATE INDEX IF NOT EXISTS idx_engagement_queue_status
  ON public.engagement_queue (status, created_at);

CREATE INDEX IF NOT EXISTS idx_engagement_queue_pending_review
  ON public.engagement_queue (telegram_sent_at)
  WHERE status = 'pending_review';

ALTER TABLE public.engagement_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS engagement_queue_service_all ON public.engagement_queue;
CREATE POLICY engagement_queue_service_all ON public.engagement_queue
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
      message: 'engagement_queue table + indexes created successfully',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to create engagement_queue',
      details: err.message,
    });
  }
};
