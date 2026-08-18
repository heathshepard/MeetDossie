-- Adds 'image_mismatch_hold' to social_posts.status's check constraint.
--
-- api/_lib/verify-image-match.js (2026-08-18) flips a row to this status
-- when a vision-model check finds the caption and the attached image don't
-- actually match (e.g. copy claims "team dashboard", image shows the
-- single-agent Pipeline view — the exact incident this closes). Held rows
-- are deliberately excluded from every existing status-based queue
-- (draft/approved/pending_video/etc.) so they never silently re-enter the
-- normal send flow.
--
-- Same technique as 20260815_social_posts_allow_linkedin_personal.sql.

ALTER TABLE public.social_posts DROP CONSTRAINT IF EXISTS social_posts_status_check;

ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_status_check
  CHECK (status IN (
    'draft', 'approved', 'publishing', 'posted', 'failed', 'pending_video', 'rejected',
    'image_mismatch_hold'
  ));
