-- 20260813_merge_queue_multi_repo.sql
-- Multi-repo Merge Queue (Carter, 2026-08-13, SV-ENG-MERGE-QUEUE-MULTI-REPO)
--
-- Heath: "I need to see all merges... across ALL my projects, not just
-- MeetDossie ... it's waiting on me." merge_queue / staging_watch_state /
-- staging_push_events were all hardcoded to a single repo
-- (heathshepard/MeetDossie). This adds a `repo` column to each so the same
-- tables can track heathshepard/DossieApp (Dossie React source) and
-- heathshepard/Rust (fitness app) too.
--
-- See api/_lib/tracked-repos.js for the registry consumed by
-- cron-staging-watcher.js, cron-merge-queue-backfill.js, merge-to-main.js,
-- merge-queue-list.js and merge-queue-add.js.
--
-- branch_from already existed on merge_queue (default 'staging') — no
-- schema change needed there. For Rust (no staging tier) it now holds the
-- real feature-branch name instead of the literal string "staging".

-- ── merge_queue: add repo, backfill existing rows to MeetDossie, index ────
ALTER TABLE public.merge_queue
  ADD COLUMN IF NOT EXISTS repo text NOT NULL DEFAULT 'heathshepard/MeetDossie';

CREATE INDEX IF NOT EXISTS idx_merge_queue_repo ON public.merge_queue(repo);

-- ── staging_watch_state: singleton -> one row per tracked repo ────────────
ALTER TABLE public.staging_watch_state
  ADD COLUMN IF NOT EXISTS repo text;

UPDATE public.staging_watch_state
  SET repo = 'heathshepard/MeetDossie'
  WHERE repo IS NULL;

ALTER TABLE public.staging_watch_state
  ALTER COLUMN repo SET NOT NULL,
  ALTER COLUMN repo SET DEFAULT 'heathshepard/MeetDossie';

-- Drop the old constant-expression singleton index, replace with a
-- per-repo uniqueness constraint.
DROP INDEX IF EXISTS idx_staging_watch_state_singleton;
CREATE UNIQUE INDEX IF NOT EXISTS idx_staging_watch_state_repo
  ON public.staging_watch_state(repo);

-- Bootstrap a row for DossieApp so the watcher's next tick picks it up.
-- last_seen_sha stays NULL -> cron-staging-watcher.js runs its bootstrap +
-- historical-backlog-queue path on first poll for this repo (queues the
-- real staging-ahead-of-main backlog into merge_queue without spamming
-- Quinn dispatch for two dozen old commits at once).
INSERT INTO public.staging_watch_state (repo, last_seen_sha)
SELECT 'heathshepard/DossieApp', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.staging_watch_state WHERE repo = 'heathshepard/DossieApp'
);

-- ── staging_push_events: add repo, backfill, index ─────────────────────────
-- Unique constraint stays on commit_sha alone — GitHub SHA-1s are globally
-- unique in practice; no cross-repo collision risk worth the extra index.
ALTER TABLE public.staging_push_events
  ADD COLUMN IF NOT EXISTS repo text NOT NULL DEFAULT 'heathshepard/MeetDossie';

CREATE INDEX IF NOT EXISTS idx_staging_push_events_repo
  ON public.staging_push_events(repo);
