-- ============================================================================
-- FAILED-RETRYABLE STATE MODEL (Atlas, 2026-10-03)
--
-- Closes the "three days and no video" gap: video 8's two rows were flipped
-- to status='failed' by cron-post-videos.js's caption-validity check (an
-- agent hung ~27h and never wrote the real caption) and were then invisible
-- to both checkNoVideoScheduledToday() and the video-priority reservation,
-- which only look at approved/pending_heath_review/heath_approved. See
-- api/_lib/video-retry.js for the full incident writeup and the state
-- model this backs.
--
-- 1. video_library.status gains 'failed_retryable' — a row whose most
--    recent publish attempt was blocked by a condition that is purely a
--    property of its own caption (empty / internal-note / premature Rust
--    store CTA), and which is therefore safe to re-check automatically.
--    Distinct from 'failed', which stays reserved for everything else
--    (an actual Zernio delivery rejection, or any future terminal failure)
--    — a genuinely broken video must never be auto-retried.
--
-- 2. failure_reason — which publish-time check caused the failure. Only
--    'invalid_caption' / 'rust_store_cta' are ever auto-retried (see
--    AUTO_RETRYABLE_REASONS in api/_lib/video-retry.js); any other value
--    is informational only.
--
-- 3. failed_at — when the row most recently failed. This is what
--    checkNoVideoScheduledToday() uses to decide a failure happened TODAY
--    (as opposed to a stale failed_retryable row from a prior day).
--
-- 4. retry_count — how many times the silence alarm has automatically
--    re-armed this row (PATCHed it back to heath_approved). Capped at
--    MAX_VIDEO_RETRIES (3) in api/_lib/video-retry.js — once reached, the
--    row is flipped to terminal 'failed' instead of being re-armed again,
--    and a dedicated alert (video_failed_retryable_exhausted) fires so
--    hitting the cap is visible rather than a silent dead end.
--
-- Applied via api/admin-migrate-video-failed-retryable.js (direct Postgres
-- connection — PostgREST cannot run DDL), same pattern as every other
-- admin-migrate-*.js route in this repo.
-- ============================================================================

ALTER TABLE public.video_library
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD COLUMN IF NOT EXISTS failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.video_library DROP CONSTRAINT IF EXISTS video_library_status_check;

ALTER TABLE public.video_library
  ADD CONSTRAINT video_library_status_check
  CHECK (status IN (
    'ready', 'pending_approval', 'approved', 'pending_heath_review', 'heath_approved',
    'posting', 'posted', 'posted_partial', 'failed', 'failed_retryable', 'rejected', 'quality_hold'
  ));

COMMENT ON CONSTRAINT video_library_status_check ON public.video_library IS
  'failed_retryable added 2026-10-03 — a publish-time failure caused purely by the row''s own caption (empty / internal-note / premature Rust store CTA), auto-retried by the silence alarm up to MAX_VIDEO_RETRIES times once the caption looks valid again. Distinct from failed (terminal — a real Zernio rejection or any other hard failure; never auto-retried). See api/_lib/video-retry.js.';

COMMENT ON COLUMN public.video_library.failure_reason IS
  'Set alongside every status=failed / failed_retryable write in api/cron-post-videos.js. invalid_caption | rust_store_cta are auto-retryable (see AUTO_RETRYABLE_REASONS in api/_lib/video-retry.js); zernio_delivery_error and anything else is terminal.';

COMMENT ON COLUMN public.video_library.failed_at IS
  'Timestamp of the most recent failure. checkNoVideoScheduledToday() (api/_lib/silence-alarm.js) uses this to scope "failed today" so a stale failed_retryable row from a prior day cannot masquerade as today''s obligation.';

COMMENT ON COLUMN public.video_library.retry_count IS
  'Incremented each time checkNoVideoScheduledToday() automatically re-arms a failed_retryable row back to heath_approved. Capped at MAX_VIDEO_RETRIES (api/_lib/video-retry.js) — at the cap the row is flipped to terminal failed instead of retried again, and video_failed_retryable_exhausted fires.';
