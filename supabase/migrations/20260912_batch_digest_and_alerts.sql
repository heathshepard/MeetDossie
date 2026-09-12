-- 20260912_batch_digest_and_alerts.sql
--
-- Two tables for two features (Heath, 2026-09-12, "I'm a bottleneck and I
-- don't like it"):
--
-- 1. weekly_digest_surfaces — backs api/cron-weekly-batch-digest.js. One row
--    per Sunday-evening digest sent to Heath. `items` is the numbered
--    mapping (position -> {table, id, ...}) so "approve post 5" / the
--    "Approve all" button can resolve back to real social_posts/group_posts
--    rows without re-querying and risking a different result than what
--    Heath actually saw. Same pattern as self_improvement's
--    improvement_digest_surfaces (candidate_ids array), generalized to two
--    source tables instead of one.
--
-- 2. alert_state — backs api/cron-silence-alarm.js. Generic one-row-per-
--    condition dedupe so a still-true condition (platform silent, approvals
--    stale, etc.) alerts once per calendar day instead of every 30-60 min
--    run. Deliberately NOT scoped to social/group posts only — any future
--    cron can reuse this by picking its own `key`.
--
-- Owner: Carter, 2026-09-12

CREATE TABLE IF NOT EXISTS public.weekly_digest_surfaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id text NOT NULL,
  message_id bigint,
  surfaced_at timestamptz NOT NULL DEFAULT now(),
  week_start date NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved_all', 'expired')),
  approved_all_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_weekly_digest_surfaces_chat_recent
  ON public.weekly_digest_surfaces (chat_id, surfaced_at DESC);

COMMENT ON TABLE public.weekly_digest_surfaces IS
  'One row per weekly batch-approval digest sent to Heath. items = numbered list mapping position -> {table: social_posts|group_posts, id, platform/group_name, day}. "Approve all" and per-post text commands (approve/reject/edit post N) resolve against the most recent open row for the chat.';
COMMENT ON COLUMN public.weekly_digest_surfaces.items IS
  'jsonb array: [{"n":1,"table":"social_posts","id":"<uuid>","platform":"facebook","day":"2026-09-14","preview":"..."}, {"n":2,"table":"group_posts","id":"<uuid>","group_name":"...","day":"2026-09-14","preview":"..."}]';

CREATE TABLE IF NOT EXISTS public.alert_state (
  key text PRIMARY KEY,
  last_fired_at timestamptz,
  last_reason text,
  metadata jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.alert_state IS
  'Generic per-condition dedupe. key = a stable string identifying the alert condition (e.g. "silence:instagram:dossie", "approvals_stale", "backlog:tiktok:video_failed"). A cron alerts only if last_fired_at is not already today (America/Chicago) for that key.';
