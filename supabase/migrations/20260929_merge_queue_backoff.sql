-- ============================================================================
-- MERGE QUEUE BACKOFF (Atlas, 2026-09-29)
--
-- WHY: cron-merge-queue-backfill re-checked every pending row (up to 100,
-- every 15 min) forever, including rows whose GitHub compare comes back
-- diverged/behind or whose sha 404s -- none of which resolve by waiting
-- another 15 minutes. That's most of what made the cron slow enough to
-- start timing out the shared every15 dispatcher group (see the 2026-09-29
-- rewrite comment in api/cron-merge-queue-backfill.js for the full incident).
--
-- Inspected the live merge_queue schema first -- no existing "last checked"
-- or "attempt count" column to reuse, so this adds two:
--   next_check_after  the row is skipped by the cron's SELECT until this
--                      time has passed. NULL (the default) means "never
--                      checked" -- always eligible immediately, and the cron
--                      orders never-checked rows first.
--   check_count        how many times the cron has looked at this row and
--                      found it still not merged. Drives exponential backoff
--                      (15min * 2^check_count, capped at 24h) computed in
--                      the cron itself -- nothing here enforces the schedule,
--                      this table only stores the bookkeeping.
--
-- Safe to re-run (IF NOT EXISTS throughout). No data touched; every existing
-- row gets next_check_after=NULL / check_count=0, which is "check it on the
-- very next tick" -- i.e. the correct migration-day behavior, not silently
-- skipping the current backlog.
--
-- Applied via api/admin-migrate-merge-queue-backoff.js (PostgREST can't run
-- DDL; direct-Postgres pattern, same as every other admin-migrate-*.js in
-- this repo).
-- ============================================================================

ALTER TABLE public.merge_queue
  ADD COLUMN IF NOT EXISTS next_check_after TIMESTAMPTZ;

ALTER TABLE public.merge_queue
  ADD COLUMN IF NOT EXISTS check_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_merge_queue_pending_backoff
  ON public.merge_queue (merged_to_main, next_check_after)
  WHERE merged_to_main = false;
