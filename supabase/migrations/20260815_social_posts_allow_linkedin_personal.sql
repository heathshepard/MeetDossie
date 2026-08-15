-- Fix: cron-generate-heath-linkedin.js writes platform='linkedin_personal'
-- (intentionally distinct from 'linkedin' so cron-publish-approved.js skips
-- it — no posting_schedule row for linkedin_personal, publishing is manual
-- via scripts/linkedin-engager.js --post-approved).
--
-- social_posts_platform_check never included this value, so every insert
-- from that cron has 400'd since it shipped, surfacing as a persistent
-- http_502 in cron_runs (cron wraps DB insert failures as 502).
--
-- Root cause of incident: cron-generate-heath-linkedin error since
-- 2026-08-14T11:03:08Z.

ALTER TABLE public.social_posts DROP CONSTRAINT IF EXISTS social_posts_platform_check;

ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_platform_check
  CHECK (platform IN ('facebook', 'instagram', 'linkedin', 'linkedin_personal', 'tiktok', 'twitter'));
