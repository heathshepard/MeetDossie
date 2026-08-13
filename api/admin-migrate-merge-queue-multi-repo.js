// One-time migration: add `repo` column to merge_queue / staging_watch_state
// / staging_push_events so the Jarvis Merge Queue can track more than just
// heathshepard/MeetDossie. See supabase/migrations/20260813_merge_queue_multi_repo.sql
// for full commentary. Safe to re-run — every statement is IF NOT EXISTS /
// idempotent, no data destroyed.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-08-13 (SV-ENG-MERGE-QUEUE-MULTI-REPO)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.merge_queue
  ADD COLUMN IF NOT EXISTS repo text NOT NULL DEFAULT 'heathshepard/MeetDossie';

CREATE INDEX IF NOT EXISTS idx_merge_queue_repo ON public.merge_queue(repo);

ALTER TABLE public.staging_watch_state
  ADD COLUMN IF NOT EXISTS repo text;

UPDATE public.staging_watch_state
  SET repo = 'heathshepard/MeetDossie'
  WHERE repo IS NULL;

ALTER TABLE public.staging_watch_state
  ALTER COLUMN repo SET NOT NULL,
  ALTER COLUMN repo SET DEFAULT 'heathshepard/MeetDossie';

DROP INDEX IF EXISTS idx_staging_watch_state_singleton;
CREATE UNIQUE INDEX IF NOT EXISTS idx_staging_watch_state_repo
  ON public.staging_watch_state(repo);

INSERT INTO public.staging_watch_state (repo, last_seen_sha)
SELECT 'heathshepard/DossieApp', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.staging_watch_state WHERE repo = 'heathshepard/DossieApp'
);

ALTER TABLE public.staging_push_events
  ADD COLUMN IF NOT EXISTS repo text NOT NULL DEFAULT 'heathshepard/MeetDossie';

CREATE INDEX IF NOT EXISTS idx_staging_push_events_repo
  ON public.staging_push_events(repo);
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
      message: 'merge_queue / staging_watch_state / staging_push_events now have a repo column; DossieApp bootstrap row inserted',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to apply merge-queue multi-repo migration',
      details: err.message,
    });
  }
};
