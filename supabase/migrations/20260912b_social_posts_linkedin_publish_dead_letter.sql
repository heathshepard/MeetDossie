-- Dead-letter support for the LinkedIn personal-post publish queue.
--
-- Bug (Carter investigation 2026-09-12): postApprovedLinkedIn() in
-- scripts/linkedin-engager.js pulls the OLDEST approved linkedin_personal
-- row first with no attempt tracking and no terminal failure state. The
-- oldest row, heath-linkedin-2026-08-15, has failed every single run since
-- 2026-09-09 on a stale LinkedIn DOM selector (button.share-box-feed-entry__trigger
-- no longer exists) and is never marked failed, never skipped. 127 attempts,
-- zero successes, 19 approved rows stranded behind it for a month.
--
-- Same technique as 20260909_social_posts_video_dead_letter.sql: track
-- attempts per row and flip to the existing terminal 'failed' status (already
-- excluded from the status=eq.approved query every publisher uses) after 3
-- failures, so one permanently-broken row can never block newer rows again.
-- No new status value needed — 'failed' is already in the check constraint
-- and already used this way by api/cron-publish-approved.js for other
-- platforms.

ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS linkedin_publish_attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.social_posts.linkedin_publish_attempts IS
  'Number of times linkedin-engager.js postApprovedLinkedIn() has attempted (and failed) to publish this row. At 3, status flips to failed and the row is permanently skipped so it can never block newer approved rows again.';
