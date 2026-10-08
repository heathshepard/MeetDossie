-- 20260925_video_library_retraction.sql
--
-- Retraction audit trail for video_library.
--
-- WHY (Atlas 2026-09-25): the pipeline could publish but never retract. Heath
-- rejected a live YouTube video ("that YT video is trash, take it down") and
-- there was no route, no column, and no record anywhere that could take a
-- published post back down. Publishing without a retraction path is a
-- one-way door on a public channel.
--
-- These columns are written by /api/admin-retract-post. Status moves to
-- 'rejected' (an already-established value, so no existing consumer has to
-- learn a new one); retracted_at is what distinguishes "retracted after it
-- went live" from "rejected before it ever shipped".
--
-- Every publish-path query in api/ filters on a positive status=eq.<value>
-- ('approved', 'heath_approved', 'ready', 'pending_*'), so 'rejected'
-- excludes a row from all of them. Verified 2026-09-25 by enumerating every
-- video_library status filter in api/ and scripts/ — none use neq or a
-- negated predicate that could let a retracted row back into a publish queue.

ALTER TABLE public.video_library
  ADD COLUMN IF NOT EXISTS retracted_at        timestamptz,
  ADD COLUMN IF NOT EXISTS retracted_by        text,
  ADD COLUMN IF NOT EXISTS retraction_reason   text,
  -- Per-platform outcome of the retraction attempt: what was tried, what the
  -- platform actually did, and the manual steps still owed where an API
  -- retraction does not exist (Instagram / TikTok / Snapchat).
  ADD COLUMN IF NOT EXISTS retraction_detail   jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.video_library.retracted_at IS
  'When this already-published video was pulled back down. NULL for rows that were rejected before publishing.';
COMMENT ON COLUMN public.video_library.retracted_by IS
  'Who ordered the retraction (e.g. "heath" or an operator/agent name).';
COMMENT ON COLUMN public.video_library.retraction_reason IS
  'Free-text why, recorded so the rejection is on the record.';
COMMENT ON COLUMN public.video_library.retraction_detail IS
  'Array of per-platform retraction results, including manual_steps where the platform has no retraction API.';

-- Find retracted rows quickly for audit without scanning the table.
CREATE INDEX IF NOT EXISTS video_library_retracted_at_idx
  ON public.video_library (retracted_at DESC)
  WHERE retracted_at IS NOT NULL;
