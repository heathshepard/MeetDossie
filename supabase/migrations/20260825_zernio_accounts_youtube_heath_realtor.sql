-- Wire the already-connected "Shepard Real Estate Solutions" YouTube channel
-- into zernio_accounts so cron-publish-approved.js's lookupZernioAccountId
-- fallback (platform + owner) can resolve it, same DB-driven pattern used
-- for the heath-realtor facebook/instagram rows added in
-- 20260818b_zernio_accounts_brokerage_profile.sql.
--
-- This channel was connected directly in the Zernio dashboard under the
-- "Brokerage" profile (profile id 6a8469b3a307bfe9b1958bc4) on 2026-08-18,
-- confirmed live via GET /v1/accounts (api/debug-zernio-accounts.js):
--   youtube accountId 6a846a0c77555aae017776e3
--   channel "Shepard Real Estate Solutions"
-- It was documented in docs/PIPELINE.md at the time ("connected and
-- available — no posting logic wired") but never inserted here, so
-- lookupZernioAccountId('youtube','heath-realtor') has always 404'd.
--
-- IMPORTANT: Zernio already holds its own OAuth grant against this YouTube
-- channel (established when Heath connected it in Zernio's dashboard) —
-- no separate Google OAuth consent is needed on our end to publish through
-- it. pushToZernio() already builds the correct payload for youtube
-- (platformSpecificData.title from post.hook; content/caption already flows
-- into the top-level `content` field, which Zernio uses as the video
-- description per docs.zernio.com/platforms/youtube).
--
-- This insert alone does not cause anything to publish: as of 2026-08-25
-- there are zero social_posts rows with platform='youtube' (content
-- generation has never been routed to this platform+owner), and any future
-- row still has to clear approved status + video_required (media_url must
-- be attached by the Creatomate/DONE pipeline) before cron-publish-approved
-- will touch it.
INSERT INTO public.zernio_accounts (platform, account_handle, zernio_account_id, owner, is_active)
SELECT 'youtube', 'Shepard Real Estate Solutions', '6a846a0c77555aae017776e3', 'heath-realtor', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.zernio_accounts WHERE platform = 'youtube' AND owner = 'heath-realtor'
);
