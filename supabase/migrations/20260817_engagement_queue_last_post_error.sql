-- ============================================================================
-- engagement_queue -- add last_post_error column
--
-- scripts/sage-engagement-queue-poster.js writes a failure reason back onto
-- the row (markFailed()) when a post attempt fails, so a failed post stays
-- visible instead of silently vanishing. The write path already existed but
-- the column did not, so the write failed non-fatally and errors went
-- unlogged. This adds the missing column.
--
-- Owner: Carter, 2026-08-17
-- ============================================================================

ALTER TABLE public.engagement_queue
  ADD COLUMN IF NOT EXISTS last_post_error TEXT;

COMMENT ON COLUMN public.engagement_queue.last_post_error IS
  'Most recent post-attempt failure reason, written by scripts/sage-engagement-queue-poster.js markFailed(). Row stays status=approved so it retries; this is for visibility only.';
