-- Video quality gate (Heath's standing rule 2026-09-15 —
-- feedback_every-video-needs-scroll-stopping-hook.md /
-- docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md). Brand-agnostic: applies to every
-- video_library row regardless of target_owner (dossie | heath-realtor).
--
-- api/_lib/verify-video-quality.js writes these columns:
--   - cover_url               explicit cover/thumbnail asset. The gate
--                             FAILS a video with no cover — see §3 of the
--                             playbook. Uploaded by
--                             scripts/queue-finished-videos.py alongside the
--                             video itself.
--   - quality_status          'passed' | 'held' | 'unchecked' (legacy/manual
--                             rows written before this migration land here).
--                             cron-post-videos.js treats anything other than
--                             'passed' as fail-closed before queuing for
--                             review or posting.
--   - quality_failed_rules    rule names that failed (empty on pass).
--   - quality_detail          full per-rule pass/fail/note JSON from
--                             checkVideoQuality(), kept for debugging without
--                             re-running ffmpeg/vision checks.
--   - quality_checked_at      when the gate last ran on this row.
--
-- status='quality_hold' is a new value in the existing free-text `status`
-- column (video_library.status has no CHECK constraint today — see
-- 20260526_video_library.sql) — no migration needed for that part.

ALTER TABLE public.video_library
  ADD COLUMN IF NOT EXISTS cover_url text,
  ADD COLUMN IF NOT EXISTS quality_status text NOT NULL DEFAULT 'unchecked',
  ADD COLUMN IF NOT EXISTS quality_failed_rules text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS quality_detail jsonb,
  ADD COLUMN IF NOT EXISTS quality_checked_at timestamptz;

ALTER TABLE public.video_library
  DROP CONSTRAINT IF EXISTS video_library_quality_status_check;

ALTER TABLE public.video_library
  ADD CONSTRAINT video_library_quality_status_check
  CHECK (quality_status IN ('unchecked', 'passed', 'held'));

CREATE INDEX IF NOT EXISTS idx_video_library_quality_status
  ON public.video_library (quality_status)
  WHERE quality_status <> 'passed';

COMMENT ON COLUMN public.video_library.quality_status IS
  'Result of api/_lib/verify-video-quality.js''s checkVideoQuality(). "unchecked" is the fail-closed default for any row the gate has not evaluated (legacy rows, manual inserts) — cron-post-videos.js will not queue-for-review or post a row that is not exactly ''passed''.';
