-- Lead-attribution instrumentation (Pierce, 2026-10-02, feat/lead-attribution-1002).
--
-- WHY THIS EXISTS
-- Heath asked whether the marketing engine produces real leads for the
-- Dossie funnel. Two new lead magnets just went live
-- (marketing/trec-deadline-checklist.html, marketing/trec-para12-breakdown.html,
-- source='trec-deadline-checklist'/'trec-para12-breakdown' in `waitlist`) and
-- the TREC calculator has been writing to `waitlist` for longer — but
-- `waitlist` has never carried first_touch/last_touch, unlike
-- founding_applications and subscriptions (see
-- supabase/migrations/20260917c_conversion_attribution_tracking.sql and
-- api/_lib/content-tag.js). Every waitlist row today answers "they gave us
-- an email" and nothing else — not which post, which platform, or which
-- piece of content actually produced the lead.
--
-- This is additive and backwards-compatible, same pattern as
-- supabase/migrations/20260930_post_analytics_owner_attribution.sql: nullable
-- columns, no backfill, no existing row touched. Client-side capture is
-- already wired (assets/dossie-acquisition.js, added to both lead-magnet
-- pages this same branch) and degrades gracefully if this migration is not
-- yet applied — the insert retries once without these fields on any
-- non-OK response, so email capture itself is never at risk either way.
--
-- NOT APPLIED as part of this branch/PR. This is schema-only and additive,
-- but it is a real production DB write and Heath has not reviewed it. Apply
-- via api/admin-migrate-waitlist-touch.js (same CRON_SECRET-gated pattern as
-- admin-migrate-post-analytics-owner.js) once approved, or run this file
-- directly.

ALTER TABLE public.waitlist
  ADD COLUMN IF NOT EXISTS first_touch JSONB,
  ADD COLUMN IF NOT EXISTS last_touch JSONB;

COMMENT ON COLUMN public.waitlist.first_touch IS
  'First-touch acquisition signal captured client-side by assets/dossie-acquisition.js: {utm_source, utm_medium, utm_campaign, content_tag, referrer, landing_page, captured_at}. content_tag decodes via api/_lib/content-tag.js parseContentTag() the same way founding_applications/subscriptions do. NULL for every row before this column existed and for any direct-traffic signup that never carried a utm/referrer signal.';

COMMENT ON COLUMN public.waitlist.last_touch IS
  'Last-touch acquisition signal, same shape as first_touch — overwritten on every page load that carries a signal, used by api/_lib/attribution.js effectiveTag() (last-touch wins, first-touch is the fallback) to decide which content_tag gets credit for this lead-magnet signup.';
