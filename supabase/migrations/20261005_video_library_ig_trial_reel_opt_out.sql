-- ============================================================================
-- INSTAGRAM TRIAL REELS OPT-OUT (Atlas, 2026-10-05)
--
-- Per memory social-growth-research-2026-09-26.md: Instagram lists follower
-- count as a Reels ranking signal, which is a documented headwind for the
-- Dossie brand account (10 followers, meetdossie/zernio_accounts). Instagram
-- Trial Reels bypass the follower graph -- shown only to non-followers, with
-- 24h insights, auto-graduating to the normal Reels/follower feed if they
-- perform within 72h (Meta docs: POST /{ig-user-id}/media `trial_params`,
-- `graduation_strategy: SS_PERFORMANCE`; confirmed exposed by Zernio as
-- platformSpecificData.trialParams.graduationStrategy -- docs.zernio.com/
-- platforms/instagram, read 2026-10-05).
--
-- api/cron-post-videos.js now defaults every Dossie-brand (target_owner=
-- 'dossie') Instagram video post to a Trial Reel. This column is the single
-- per-row escape hatch for a post that should NOT go the Trial Reel route
-- (e.g. something Heath wants guaranteed full follower-feed reach on day 1,
-- or a post whose performance-based graduation timing doesn't matter).
--
-- Default FALSE = Trial Reel is the default behavior; opt OUT, not in.
--
-- Applied via api/admin-migrate-video-library-ig-trial-reel-opt-out.js
-- (direct Postgres connection -- PostgREST cannot run DDL), same pattern as
-- every other admin-migrate-*.js route in this repo.
-- ============================================================================

ALTER TABLE public.video_library
  ADD COLUMN IF NOT EXISTS ig_trial_reel_opt_out boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.video_library.ig_trial_reel_opt_out IS
  'Per-row opt-out from the default Instagram Trial Reel behavior (api/cron-post-videos.js postToZernio()). Trial Reels are ON by default for target_owner=''dossie'' Instagram posts -- set this TRUE to publish as a normal Reel instead. Never applies to owner=''heath-realtor'' (982 followers already -- Trial Reels solve a cold-start problem that account does not have).';
