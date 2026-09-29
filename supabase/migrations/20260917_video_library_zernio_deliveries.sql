-- Pipeline B (video_library -> cron-post-videos.js -> Zernio) delivery
-- verification. Previously cron-verify-posts.js and
-- cron-verify-zernio-deliveries.js only covered social_posts rows -- a
-- video_library row marked status='posted' had no per-platform Zernio post
-- id persisted anywhere, so nothing could ever confirm it actually
-- delivered. Closes that silent-failure gap (Carter, 2026-09-17).
--
-- zernio_deliveries: one entry per platform this video was sent to.
--   { platform, zernio_post_id, scheduled_for, accepted_at, status,
--     proof_level, platform_url, verified_at, error, alerted_at }
-- proof_level values: 'unconfirmed' | 'zernio_confirmed_no_url' |
-- 'zernio_confirmed_live_url'. See api/_lib/video-delivery-verify.js.
alter table public.video_library
  add column if not exists zernio_deliveries jsonb not null default '[]'::jsonb;

create index if not exists video_library_status_posted_date_idx
  on public.video_library (status, posted_date);
