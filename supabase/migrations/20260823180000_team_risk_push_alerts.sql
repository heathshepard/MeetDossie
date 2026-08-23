-- ============================================================================
-- Real-time push alerts for team risk-triage — additive to the weekly digest
-- (api/cron-weekly-team-risk-digest.js), not a replacement for it.
--
-- Built 2026-08-23 (Carter), following the same day's Web Push infra built
-- for Jarvis (supabase/migrations/20260822_push_subscriptions.sql). That
-- table is Jarvis-specific and gated to heath.shepard@kw.com only (single-
-- tenant, blanket "authenticated" RLS). This app is multi-tenant — many
-- Team/Brokerage orgs, each with their own admin(s) — so it needs its own
-- table with real per-org RLS, not a reuse of push_subscriptions.
--
-- Two tables:
--   1. team_risk_push_subscriptions — one row per (org admin, browser/device)
--      Web Push subscription. Written by api/team/risk-push-subscribe.js,
--      read by api/cron-hourly-team-risk-alerts.js.
--   2. team_risk_alerts_sent — dedup ledger so the same overdue item /
--      missing disclosure / deadline flag doesn't re-push every hour forever.
--      One row per (org_id, risk_key) still-outstanding condition. The cron
--      deletes a row once its condition resolves, so if the SAME condition
--      recurs later it alerts again (not permanently suppressed).
--   3. team_risk_alert_state — one row per org, written once on that org's
--      first-ever cron pass. Prevents a false "backlog flood": without this,
--      the very first hourly run for a brand-new org (or one enabling this
--      feature after months of Dossie use) would treat every already-
--      outstanding risk item as "new" and fire a burst of pushes for old
--      conditions the team lead already knows about. First pass seeds
--      team_risk_alerts_sent silently (no push sent); every pass after that
--      alerts on genuinely new conditions only.
--
-- Owner: Carter (SV-ENG-TEAM-RISK-PUSH / 2026-08-23)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.team_risk_push_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Same W3C PushSubscription shape as push_subscriptions (endpoint is the
  -- natural per-browser+device dedupe/upsert key).
  endpoint      TEXT NOT NULL UNIQUE,
  p256dh        TEXT NOT NULL,
  auth_key      TEXT NOT NULL,

  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.team_risk_push_subscriptions IS
  'Web Push subscriptions for the Dossie Team Dashboard risk-alert feature. One row per (org admin, browser/device). Sent-to by api/cron-hourly-team-risk-alerts.js using the web-push npm package + VAPID_PRIVATE_KEY (same VAPID keypair as Jarvis push).';

CREATE INDEX IF NOT EXISTS idx_team_risk_push_subscriptions_org
  ON public.team_risk_push_subscriptions (org_id);
CREATE INDEX IF NOT EXISTS idx_team_risk_push_subscriptions_user
  ON public.team_risk_push_subscriptions (user_id);

ALTER TABLE public.team_risk_push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Real per-org RLS (unlike push_subscriptions' blanket "authenticated"
-- policy — this table spans many orgs). Reuses the same is_org_admin(org_id)
-- SECURITY DEFINER helper the transactions/documents/action_items org-admin
-- policies already use (supabase/migrations/20260619163812_multitenant_
-- phase3_org_id_audit_vault.sql). Service-role writes from
-- api/team/risk-push-subscribe.js and the cron bypass RLS regardless; this
-- is defense-in-depth matching the rest of the multi-tenant schema.
CREATE POLICY "org_admin_select_team_risk_push_subscriptions"
  ON public.team_risk_push_subscriptions FOR SELECT
  USING (public.is_org_admin(org_id));

CREATE POLICY "org_admin_insert_team_risk_push_subscriptions"
  ON public.team_risk_push_subscriptions FOR INSERT
  WITH CHECK (public.is_org_admin(org_id));

CREATE POLICY "org_admin_update_team_risk_push_subscriptions"
  ON public.team_risk_push_subscriptions FOR UPDATE
  USING (public.is_org_admin(org_id));

CREATE POLICY "org_admin_delete_team_risk_push_subscriptions"
  ON public.team_risk_push_subscriptions FOR DELETE
  USING (public.is_org_admin(org_id));

-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.team_risk_alerts_sent (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- risk_key uniquely identifies one specific risk condition within an org:
  --   'disclosure:{transaction_id}:{doc_type}'
  --   'action_item:{action_item_id}'
  --   'deadline:{transaction_id}:{flag}'
  -- (flag is one of the computeDeadlineFlags() values in team-risk-rollup.js,
  -- e.g. 'past_option_expiration'.)
  risk_key          TEXT NOT NULL,
  category          TEXT NOT NULL CHECK (category IN ('disclosure', 'action_item', 'deadline')),
  transaction_id    UUID,

  first_alerted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_alerted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (org_id, risk_key)
);

COMMENT ON TABLE public.team_risk_alerts_sent IS
  'Dedup ledger for api/cron-hourly-team-risk-alerts.js. One row per still-outstanding risk condition already pushed to the org''s team leads. Deleted by the cron once the condition resolves (doc uploaded / item completed / deadline no longer in the past on an open file), so a recurring instance of the SAME condition alerts again rather than being permanently silenced.';

CREATE INDEX IF NOT EXISTS idx_team_risk_alerts_sent_org
  ON public.team_risk_alerts_sent (org_id);

ALTER TABLE public.team_risk_alerts_sent ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_admin_select_team_risk_alerts_sent"
  ON public.team_risk_alerts_sent FOR SELECT
  USING (public.is_org_admin(org_id));

-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.team_risk_alert_state (
  org_id              UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  baseline_seeded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.team_risk_alert_state IS
  'One row per org, written on that org''s first-ever api/cron-hourly-team-risk-alerts.js pass. Existence of a row means the baseline backlog has been seeded into team_risk_alerts_sent WITHOUT sending push — every pass after that alerts on genuinely new conditions only. Deliberately NOT derived from team_risk_alerts_sent row-count (an org can legitimately have zero outstanding risk at some point, which must not be mistaken for "never seen before").';

ALTER TABLE public.team_risk_alert_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_admin_select_team_risk_alert_state"
  ON public.team_risk_alert_state FOR SELECT
  USING (public.is_org_admin(org_id));
