-- Adds a real CHECK constraint to video_library.status (there was none —
-- see 20260915_video_library_quality_gate.sql's own comment: "video_library
-- .status has no CHECK constraint today") and, in the same statement, allows
-- the new 'posted_partial' value.
--
-- Atlas 2026-09-30 — the video partial-delivery investigation. Measured
-- live against video_library (2026-09-28/29): rows targeting 3-5 platforms
-- in a single row (e.g. dossie_trec_p12b_contribution-dossie-multi,
-- platforms=[facebook,instagram,tiktok,linkedin,twitter]) landed
-- status='posted' with zernio_deliveries covering only 2 of the 5 —
-- facebook/linkedin were gated out by an already-exhausted same-day
-- per-(owner,platform) daily cap (shared with the text/carousel pipeline,
-- api/cron-publish-approved.js, which runs on its own schedule and can
-- consume the day's cap before the video queue's batch scan gets a turn),
-- and twitter was gated out because posting_schedule's shared row is
-- permanently is_active=false for every owner except 'rust'. The row still
-- reported 100% success. See docs/... (report delivered in this task) for
-- the full per-row evidence trail.
--
-- 'posted' now means every originally-targeted platform was at least
-- attempted (a real postToZernio() call, whatever its outcome). A row with
-- ANY platform gated out before ever reaching Zernio now lands in
-- 'posted_partial' instead — zernio_deliveries carries a 'gate_skipped'
-- entry (api/_lib/video-delivery-verify.js's buildSkipEntry()) for every
-- such platform, with the gate reason (cap/inactive/no-schedule), so the
-- row is a complete per-platform record rather than silently looking like
-- full success.
--
-- Same technique as 20260818's image_mismatch_hold, 20260909's
-- video_failed, 20260930c's parked_no_account, and 20260930d's
-- posted_unverified (social_posts' sibling fix, same day).
--
-- Applied via api/admin-migrate-video-posted-partial-status.js (direct
-- Postgres connection — PostgREST can't run DDL), same pattern as
-- api/admin-migrate-posted-unverified-status.js.

ALTER TABLE public.video_library DROP CONSTRAINT IF EXISTS video_library_status_check;

ALTER TABLE public.video_library
  ADD CONSTRAINT video_library_status_check
  CHECK (status IN (
    'ready', 'pending_approval', 'approved', 'pending_heath_review', 'heath_approved',
    'posting', 'posted', 'posted_partial', 'failed', 'rejected', 'quality_hold'
  ));

COMMENT ON CONSTRAINT video_library_status_check ON public.video_library IS
  'posted_partial added 2026-09-30 — one or more originally-targeted platforms were gated out (daily cap / inactive schedule / no schedule row) before ever reaching Zernio. Distinct from posted (every targeted platform was at least attempted) and failed (a platform that WAS attempted got a hard Zernio rejection). See 20260930e_video_library_posted_partial_status.sql and api/_lib/video-delivery-verify.js buildSkipEntry().';
