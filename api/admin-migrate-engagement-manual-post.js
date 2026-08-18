// One-time migration: manual-post handoff for engagement_queue.
// Widens the status CHECK constraint to add 'awaiting_manual_post', adds
// handoff_message_id/handoff_sent_at columns, and creates the
// engagement_post_log audit table. Safe to re-run (IF NOT EXISTS / DROP+
// re-ADD CONSTRAINT with the same definition).
//
// DDL isn't reachable through PostgREST, so this runs directly against
// Postgres via api/_lib/pg-admin.js (POSTGRES_URL_NON_POOLING). Mirrors
// supabase/migrations/20260818_engagement_queue_manual_post_handoff.sql and
// the exact pattern of api/admin-migrate-engagement-queue-last-post-error.js.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-08-18

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.engagement_queue
  DROP CONSTRAINT IF EXISTS engagement_queue_status_check;

ALTER TABLE public.engagement_queue
  ADD CONSTRAINT engagement_queue_status_check
  CHECK (status IN (
    'pending_review', 'approved', 'awaiting_manual_post', 'rejected',
    'posted', 'expired'
  ));

ALTER TABLE public.engagement_queue
  ADD COLUMN IF NOT EXISTS handoff_message_id BIGINT;

ALTER TABLE public.engagement_queue
  ADD COLUMN IF NOT EXISTS handoff_sent_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.engagement_post_log (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_queue_id   UUID REFERENCES public.engagement_queue(id) ON DELETE SET NULL,
  group_name            TEXT NOT NULL,
  permalink             TEXT,
  drafted_reply         TEXT,
  posted_at             TIMESTAMPTZ NOT NULL,
  confirmed_via         TEXT NOT NULL DEFAULT 'telegram_button',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_engagement_post_log_posted_at
  ON public.engagement_post_log (posted_at);

ALTER TABLE public.engagement_post_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'engagement_post_log'
      AND policyname = 'engagement_post_log_service_all'
  ) THEN
    CREATE POLICY engagement_post_log_service_all ON public.engagement_post_log
      FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;
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
      message: 'engagement_queue manual-post handoff migration applied successfully',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to apply engagement_queue manual-post handoff migration',
      details: err.message,
    });
  }
};
