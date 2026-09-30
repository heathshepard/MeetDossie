-- Adds 'posted_unverified' to social_posts.status's check constraint.
--
-- Atlas 2026-09-30 — the zernio_post_id write-back gap. Measured: two of
-- today's rows (819c86d1 facebook, a277a0cb linkedin) landed status='posted'
-- with zernio_post_id NULL and error_message NULL — indistinguishable from a
-- normal verified post. One was independently confirmed live on LinkedIn via
-- GET https://zernio.com/api/v1/posts, so the send genuinely succeeded; this
-- is a write-back failure, not a delivery failure (root cause:
-- api/cron-verify-posts.js's own pushToZernio() had a narrower post-id
-- extraction fallback chain than api/cron-publish-approved.js's, and missed
-- the `data.post._id` shape entirely — fixed in the same change as this
-- migration).
--
-- Up to now, 'posted' meant two different things depending on whether
-- zernio_post_id was populated, distinguished only by an error_message
-- string nobody queries on. That means 'posted' could never be trusted at
-- face value. This migration gives the unverified case its own status so a
-- verifiable identifier is a precondition for status='posted', full stop.
-- A publish that got a 2xx from Zernio but no identifier back now lands in
-- 'posted_unverified' instead — still counts as "sent" for
-- duplicate-content and daily-cap purposes (see the accompanying code
-- changes to isDuplicateRecentPost/countPostedToday/countPostedRecently),
-- but is never silently indistinguishable from a verified post.
--
-- Same technique as 20260818's image_mismatch_hold, 20260909's
-- video_failed, and 20260930c's parked_no_account.
--
-- Restore/backfill query, once a genuinely-missing id is found later (e.g.
-- matched read-only against Zernio's GET /posts — never by re-publishing):
--
--   UPDATE public.social_posts
--   SET status = 'posted', zernio_post_id = '<confirmed id>', error_message = NULL
--   WHERE id = '<row id>' AND status = 'posted_unverified';

ALTER TABLE public.social_posts DROP CONSTRAINT IF EXISTS social_posts_status_check;

ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_status_check
  CHECK (status IN (
    'draft', 'approved', 'publishing', 'posted', 'failed', 'pending_video', 'rejected',
    'image_mismatch_hold', 'video_failed', 'parked_no_account', 'posted_unverified'
  ));

COMMENT ON CONSTRAINT social_posts_status_check ON public.social_posts IS
  'posted_unverified added 2026-09-30 — Zernio returned a 2xx with no extractable post identifier. Distinct from posted (verified survival) and failed (Zernio rejected the request). See 20260930d_social_posts_posted_unverified_status.sql.';
