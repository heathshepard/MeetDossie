-- Attribute post_analytics rows to WHICH Zernio account posted (brand vs
-- personal), and let a row reference a video_library post (Pipeline B) as
-- well as a social_posts one (Pipeline A).
--
-- WHY (Atlas, 2026-09-30 -- video-routing-personal-accounts task):
-- Heath's founder-selfie videos are being rerouted to post primarily
-- through his own personal accounts (zernio_accounts owner='heath-realtor')
-- instead of the near-zero-follower Dossie brand accounts. Measuring
-- whether that actually works requires telling a heath-realtor facebook
-- row apart from a dossie facebook row -- today post_analytics has NO
-- owner/account column at all, so a facebook row from @MeetDossie and one
-- from @HeathShepardRealtor are indistinguishable.
--
-- SEPARATE, BIGGER GAP FOUND WHILE BUILDING THIS (also fixed here):
-- post_analytics.social_post_id is a hard FK to social_posts ONLY.
-- video_library posts (cron-post-videos.js, Pipeline B -- the entire
-- pipeline this routing change runs through) have NEVER had any way to
-- land a row in post_analytics, regardless of which account posted them.
-- Confirmed live 2026-09-30: zero post_analytics rows reference a video
-- post today. Every "1 view / 0 views / 2 views" number in the 45-day
-- baseline this routing change is measured against comes from the
-- TEXT/carousel pipeline (social_posts) only -- video engagement has been
-- completely unmeasured this whole time. video_library_id (below) is an
-- alternate, optional FK so a caller can record either kind of post
-- without touching social_post_id's existing semantics.
--
-- NOT APPLIED as part of this branch/PR -- this is schema-only and
-- additive/backwards-compatible, but it is a real production DB write and
-- Heath has not reviewed this change. Apply via
-- api/admin-migrate-post-analytics-owner.js (mirrors the existing
-- admin-migrate-zernio-page-id.js pattern) once approved, or run this file
-- directly. See that file's header for the exact curl.

ALTER TABLE public.post_analytics
  ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT 'dossie',
  ADD COLUMN IF NOT EXISTS account_handle TEXT,
  ADD COLUMN IF NOT EXISTS video_library_id TEXT REFERENCES public.video_library(id) ON DELETE CASCADE;

-- "Exactly one of social_post_id / video_library_id" -- a row is never
-- orphaned from both (unattributable) and never double-counted against
-- both. Every existing row already has social_post_id set and
-- video_library_id NULL, so num_nonnulls(...) = 1 for all of them --
-- this constraint is satisfiable by the current table with zero backfill.
ALTER TABLE public.post_analytics
  DROP CONSTRAINT IF EXISTS post_analytics_exactly_one_source;
ALTER TABLE public.post_analytics
  ADD CONSTRAINT post_analytics_exactly_one_source
  CHECK (num_nonnulls(social_post_id, video_library_id) = 1);

-- Second per-day uniqueness path for a video-sourced row (the existing
-- unique_post_per_day constraint only covers social_post_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_post_analytics_video_per_day
  ON public.post_analytics (video_library_id, sync_date)
  WHERE video_library_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_post_analytics_owner
  ON public.post_analytics (owner, fetched_at DESC);

COMMENT ON COLUMN public.post_analytics.owner IS
  'Which Zernio account family posted this: dossie (brand) | heath-realtor (Heath''s personal accounts) | rust. Matches zernio_accounts.owner. Defaults to dossie for every pre-2026-09-30 row (the only owner that existed when this table was first written).';
COMMENT ON COLUMN public.post_analytics.account_handle IS
  'Denormalized @handle/Page name of the specific account (e.g. @meetdossie vs @heathshepardrealtor) -- lets two rows with the same platform+owner still be told apart if an owner ever has two accounts on one platform.';
COMMENT ON COLUMN public.post_analytics.video_library_id IS
  'Set when this row is Pipeline B (video_library -> cron-post-videos.js) engagement, never alongside social_post_id. NULL for every pre-2026-09-30 row (Pipeline A / social_posts only -- video posts have never been recorded here before this migration).';
