-- Dead-letter support for the video render queue.
--
-- Bug (Sage investigation 2026-09-09, docs/POSTING-ENGINE-PLAN-2026-09-09.md):
-- cron-render-videos.js pulls the OLDEST unrendered rows first with no
-- attempt tracking and no terminal failure state. Creatomate has returned
-- 402 Insufficient credits since 2026-06-30, so the same handful of oldest
-- rows get retried forever and every newer post behind them never gets
-- attempted. 48 rows stuck as of 2026-09-09.
--
-- Fix: track render attempts per row. After 3 failures the row moves to the
-- new terminal 'video_failed' status (excluded from every existing
-- status-based queue, same technique as 20260818_social_posts_image_mismatch_hold_status.sql)
-- so a permanently-broken row can never block newer posts again.

ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS render_attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.social_posts.render_attempts IS
  'Number of times cron-render-videos.js has attempted (and failed) to render this row. At 3, status flips to video_failed and the row is skipped permanently.';

ALTER TABLE public.social_posts DROP CONSTRAINT IF EXISTS social_posts_status_check;

ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_status_check
  CHECK (status IN (
    'draft', 'approved', 'publishing', 'posted', 'failed', 'pending_video', 'rejected',
    'image_mismatch_hold', 'video_failed'
  ));
