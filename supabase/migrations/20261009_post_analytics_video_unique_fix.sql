-- Fixes a defect in 20260930_post_analytics_owner_attribution.sql, found
-- live 2026-10-09 (Atlas, analytics-sync-video-link task): that migration
-- created idx_post_analytics_video_per_day as a PARTIAL unique index
-- (`WHERE video_library_id IS NOT NULL`). PostgREST's upsert translates
-- `on_conflict=video_library_id,sync_date` into a plain
-- `ON CONFLICT (video_library_id, sync_date)` clause with no WHERE
-- predicate -- Postgres cannot infer a partial index from that (error
-- 42P10: "there is no unique or exclusion constraint matching the ON
-- CONFLICT specification"). Confirmed live: every post_analytics upsert
-- for a video_library row 400'd with exactly this error, which is also
-- WHY post_analytics had not synced since 2026-09-27 for ANY row (video
-- or social) once the owner/account_handle columns from that migration
-- started being written -- the video branch was unreachable via a 200,
-- but the whole run's error list masked that the social branch was
-- failing for an unrelated reason (columns not yet existing) until this
-- migration + that one were both applied in order.
--
-- FIX: a plain (non-partial) UNIQUE index on (video_library_id, sync_date)
-- behaves identically for our purposes -- Postgres never treats two NULLs
-- as equal in a unique index, so social-post rows (video_library_id
-- always NULL) never collide with each other or with a video row under
-- this index either way. Dropping the WHERE clause only removes the
-- on-disk savings of a partial index; it changes no runtime behavior this
-- table depends on.
--
-- Apply via api/admin-migrate-post-analytics-video-unique-fix.js (same
-- admin-migrate pattern as 20260930's own apply path) once approved, or
-- run this file directly.

DROP INDEX IF EXISTS public.idx_post_analytics_video_per_day;

CREATE UNIQUE INDEX IF NOT EXISTS idx_post_analytics_video_per_day
  ON public.post_analytics (video_library_id, sync_date);

-- SECOND DEFECT found applying the fix above live, 2026-10-09: the live
-- post_analytics.social_post_id column is NOT NULL (the original
-- 20260612_post_analytics_and_delivery_verification.sql DDL on file for
-- this table does not show that, but the live column has it regardless --
-- probably set via the Supabase dashboard at some point, outside this
-- migration history). 20260930_post_analytics_owner_attribution.sql's
-- "exactly one of social_post_id / video_library_id" CHECK constraint is
-- unsatisfiable for a video row with that NOT NULL still in place -- every
-- video upsert 400'd with Postgres 23502 ("null value in column
-- social_post_id ... violates not-null constraint") even after the index
-- fix above. Drop it; the new CHECK constraint is the thing enforcing
-- "never actually orphaned from both" now, so the column-level NOT NULL is
-- redundant for social rows and actively wrong for video rows.
ALTER TABLE public.post_analytics
  ALTER COLUMN social_post_id DROP NOT NULL;
