-- Weekly recording kit GAP 4 (docs/WEEKLY-RECORDING-KIT.md, Sage 2026-09-10).
-- video_library has no way to say "this clip is Heath's realtor page, not
-- Dossie" — cron-post-videos.js was hardcoded to Dossie's own Zernio
-- accounts for every row. Mirrors the existing social_posts.target_owner
-- pattern (20260817_social_posts_target_owner.sql) exactly, so the same
-- zernio_accounts owner rows ('dossie' | 'heath-realtor', see
-- 20260817_zernio_accounts_owner.sql / 20260818b_zernio_accounts_brokerage_profile.sql)
-- resolve correctly for both social_posts AND video_library.
--
-- Defaults every existing/future row to 'dossie' — zero behavior change
-- until scripts/queue-finished-videos.py explicitly writes
-- target_owner='heath-realtor' for a clip dropped in
-- Media/finished-videos/realtor/.

ALTER TABLE public.video_library
  ADD COLUMN IF NOT EXISTS target_owner text NOT NULL DEFAULT 'dossie';

ALTER TABLE public.video_library
  DROP CONSTRAINT IF EXISTS video_library_target_owner_check;

ALTER TABLE public.video_library
  ADD CONSTRAINT video_library_target_owner_check
  CHECK (target_owner IN ('dossie', 'heath-realtor'));

CREATE INDEX IF NOT EXISTS idx_video_library_target_owner
  ON public.video_library (target_owner)
  WHERE target_owner <> 'dossie';

COMMENT ON COLUMN public.video_library.target_owner IS
  'Which zernio_accounts.owner this video publishes through: dossie (default, MeetDossie Pages) or heath-realtor (Heath''s personal facebook.com/HeathShepardRealtor / @heathshepardrealtor). Read by cron-post-videos.js postToZernio() to pick the right zernio_account_id + Facebook Page when platform alone is ambiguous.';
