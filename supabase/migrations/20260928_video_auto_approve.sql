-- Video auto-approve (Atlas, 2026-09-28).
--
-- Heath, after two finished videos sat unposted a full day because the
-- Telegram approval card was never seen (2026-09-28): "Auto-approve videos
-- that pass the quality gate... the human tap adds delay, not safety."
--
-- See api/_lib/ops-policy.js CAPABILITIES.video_auto_approve for the full
-- gate contract (quality_status='passed' with zero failed rules, no
-- unverified TREC claim in the caption, not the first run of a new
-- format). api/cron-post-videos.js STEP 1 reads this flag via
-- checkCapability('video_auto_approve').
--
-- Ships OFF -- report mode. cron-post-videos.js logs "would auto-approve"
-- for every eligible row without touching status until Heath flips this.

insert into ops_flags (key, enabled, reason, updated_by) values
  ('video_auto_approve_live',
   false,
   'Advance approved -> heath_approved with no Telegram tap once quality_status=passed cleanly, no TREC claim, not a first-of-format run. OFF = report-mode only (cron-post-videos.js logs what it would auto-approve).',
   'atlas')
on conflict (key) do nothing;
