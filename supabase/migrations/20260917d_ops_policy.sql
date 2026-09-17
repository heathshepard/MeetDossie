-- 20260917d_ops_policy.sql
--
-- STANDING AUTHORITY, ENCODED. Heath's ask, 2026-09-17: "what can act
-- without me" is scattered today across kill switches, engagement caps, and
-- agent instructions scattered across a dozen files. This makes it ONE
-- explicit, DB-enforced policy, extending public.ops_flags (the shared
-- switch table from 20260916c_ops_flags.sql) rather than inventing a new
-- mechanism.
--
-- THE POLICY (full readable definition + enforcement lives in
-- api/_lib/ops-policy.js — this migration only provisions the storage):
--
--   ACTS AUTONOMOUSLY (an ops_flags row, default enabled, Heath can turn any
--   of these off without a deploy):
--     - publish_content          — cron-publish-approved.js: a post that
--                                  already passed its schedule/dedup/media/
--                                  video-required/caption-sanitizer gates.
--     - reply_low_risk_comments — the EXISTING 'auto_reply' flag
--                                  (20260916_auto_reply_veto.sql). Not
--                                  renamed/duplicated here — this migration
--                                  only documents that it IS the flag behind
--                                  this capability.
--     - schedule_week_ahead      — cron-weekly-content-scheduler.js advance-
--                                  filling the next 7 days of drafts.
--     - harvest_and_draft        — scripts/harvest-tc-discovery-responses.js
--                                  + api/cron-comment-opp-approval.js's
--                                  score+draft step (never the post itself).
--     - batch_routine_approvals  — whether routine (non-time-sensitive)
--                                  per-item approval pings get folded into
--                                  the one daily morning brief instead of
--                                  firing individually the moment they're
--                                  found. Off reverts to the old
--                                  ping-per-item behavior.
--
--   ALWAYS HEATH (deliberately NOT a row here — see the CHECK constraint
--   below, which makes it structurally impossible to ever create one):
--     - spend_money
--     - contact_real_client
--     - irreversible_public_under_license
--     - pricing_demo_complaint_conversation
--     - new_account_or_credential
--   These are hard-coded in api/_lib/ops-policy.js's ALWAYS_HEATH map and
--   ALWAYS return allowed:false from checkCapability() — no flag, no env
--   var, and no code path can flip them autonomous. The CHECK constraint is
--   belt-and-suspenders: even a stray INSERT trying to create a flag row
--   under one of these names is rejected by Postgres itself.
--
-- LOGGING: every autonomous action call site logs to ops_action_log below —
-- what capability authorized it, what gate(s) it passed, and a pointer back
-- to the row it acted on, so a wrong call is diagnosable after the fact
-- instead of mysterious (Heath's exact ask).
--
-- Owner: Carter, 2026-09-17

-- ── Reserve the ALWAYS-HEATH capability names so they can never become a
-- real ops_flags row, even by accident or a future careless insert.
ALTER TABLE public.ops_flags
  DROP CONSTRAINT IF EXISTS ops_flags_no_always_heath_keys;
ALTER TABLE public.ops_flags
  ADD CONSTRAINT ops_flags_no_always_heath_keys
  CHECK (key NOT IN (
    'spend_money',
    'contact_real_client',
    'irreversible_public_under_license',
    'pricing_demo_complaint_conversation',
    'new_account_or_credential'
  ));

-- ── New autonomous-capability flags. Defaults match CURRENT live behavior
-- (these pipelines already run unattended today) — this migration makes
-- that fact explicit and independently controllable, it does not newly
-- grant anything. ON CONFLICT no-op so re-running never clobbers a value
-- Heath has already changed.
INSERT INTO public.ops_flags (key, enabled, reason, updated_by) VALUES
  ('publish_content', TRUE,
   'capability policy 2026-09-17 — publishing is autonomous once schedule/dedup/media/sanitizer gates pass',
   'migration:20260917d_ops_policy'),
  ('schedule_week_ahead', TRUE,
   'capability policy 2026-09-17 — advance-fill scheduling is autonomous',
   'migration:20260917d_ops_policy'),
  ('harvest_and_draft', TRUE,
   'capability policy 2026-09-17 — comment harvesting + drafting is autonomous (never the post itself)',
   'migration:20260917d_ops_policy'),
  ('batch_routine_approvals', TRUE,
   'capability policy 2026-09-17 — routine (non-time-sensitive) approvals batch into the one morning brief instead of a ping per item',
   'migration:20260917d_ops_policy')
ON CONFLICT (key) DO NOTHING;

-- ── Audit trail: every autonomous action, what fired it, what gate it
-- passed. Append-only by convention (application code never UPDATEs a row
-- here); a wrong call is diagnosed by reading history, not by trusting a
-- mutable "current state".
CREATE TABLE IF NOT EXISTS public.ops_action_log (
  id           BIGSERIAL PRIMARY KEY,
  capability   TEXT NOT NULL,     -- ops_flags.key that authorized this (or the ALWAYS_HEATH key that BLOCKED it)
  decision     TEXT NOT NULL CHECK (decision IN ('autonomous', 'blocked_always_heath', 'blocked_flag_off')),
  action       TEXT NOT NULL,     -- short human description of what happened / was attempted
  fired_by     TEXT NOT NULL,     -- the cron/script/file that took or attempted the action
  gates_passed TEXT[] NOT NULL DEFAULT '{}',
  ref_table    TEXT,
  ref_id       TEXT,
  metadata     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.ops_action_log IS
  'Audit trail for api/_lib/ops-policy.js. One row per autonomous action taken (decision=autonomous) or per attempt the policy blocked (blocked_*). This is what makes "why did the system do that" diagnosable after the fact instead of mysterious.';
COMMENT ON COLUMN public.ops_action_log.capability IS
  'The ops-policy capability key involved — one of publish_content, reply_low_risk_comments (auto_reply), schedule_week_ahead, harvest_and_draft, batch_routine_approvals, or an ALWAYS_HEATH key when decision=blocked_always_heath.';
COMMENT ON COLUMN public.ops_action_log.gates_passed IS
  'Which content/quality/risk gates the action passed before firing — e.g. {schedule,dedup,media_required,caption_sanitizer} for a publish, or {risk_classifier_low_risk,content_gates,veto_window_no_stop} for an auto-approved reply.';

CREATE INDEX IF NOT EXISTS idx_ops_action_log_capability_time
  ON public.ops_action_log (capability, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_action_log_ref
  ON public.ops_action_log (ref_table, ref_id)
  WHERE ref_table IS NOT NULL;

-- Same RLS pattern as ops_flags / telegram_send_log: enable, zero policies.
-- Every real caller uses SUPABASE_SERVICE_ROLE_KEY (bypasses RLS); anon/
-- authenticated default to deny-all.
ALTER TABLE public.ops_action_log ENABLE ROW LEVEL SECURITY;

-- ── 1:1 DM LINK ATTRIBUTION — closes the "group comments never mention
-- Dossie, so the conversation that actually converts is invisible" gap
-- (Heath, 2026-09-17, from the 30-day plan). When a group-comment
-- conversation moves to 1:1 and a link finally goes out, it's generated
-- via api/_lib/dm-link.js (format='dm' content_tag, decodable the same way
-- as every published-post tag — see api/_lib/content-tag.js) and cached
-- here so the SAME tap always returns the SAME link/tag instead of
-- generating a new one (and a new click id) every time Heath re-opens the
-- Telegram card.
ALTER TABLE public.tc_discovery_responses
  ADD COLUMN IF NOT EXISTS dm_link_tag TEXT;
ALTER TABLE public.comment_opportunities
  ADD COLUMN IF NOT EXISTS dm_link_tag TEXT;

COMMENT ON COLUMN public.tc_discovery_responses.dm_link_tag IS
  'content_tag (api/_lib/content-tag.js buildContentTag(), format=''dm'') stamped on the 1:1 link Heath sends once this comment conversation moves off the public thread. NULL = no DM link generated yet for this conversation.';
COMMENT ON COLUMN public.comment_opportunities.dm_link_tag IS
  'Same as tc_discovery_responses.dm_link_tag — the 1:1 DM link tag for this comment-opportunity conversation, once generated.';
