// One-time migration: create public.team_risk_push_subscriptions,
// public.team_risk_alerts_sent, public.team_risk_alert_state — real-time
// push alerts for team risk-triage. See
// supabase/migrations/20260823180000_team_risk_push_alerts.sql for the full
// design commentary.
//
// Safe to re-run — every statement is IF NOT EXISTS / DROP-then-CREATE. No
// data is touched.
//
// This route exists because POSTGRES_URL_NON_POOLING is a write-only
// ("Sensitive") Vercel var, so DDL cannot be run from a local shell — the
// pulled value is the literal [SENSITIVE]. Same pattern as the
// admin-migrate-push-subscriptions.js sibling (2026-08-22).
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-08-23 (SV-ENG-TEAM-RISK-PUSH)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
CREATE TABLE IF NOT EXISTS public.team_risk_push_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
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

DROP POLICY IF EXISTS "org_admin_select_team_risk_push_subscriptions" ON public.team_risk_push_subscriptions;
CREATE POLICY "org_admin_select_team_risk_push_subscriptions"
  ON public.team_risk_push_subscriptions FOR SELECT
  USING (public.is_org_admin(org_id));

DROP POLICY IF EXISTS "org_admin_insert_team_risk_push_subscriptions" ON public.team_risk_push_subscriptions;
CREATE POLICY "org_admin_insert_team_risk_push_subscriptions"
  ON public.team_risk_push_subscriptions FOR INSERT
  WITH CHECK (public.is_org_admin(org_id));

DROP POLICY IF EXISTS "org_admin_update_team_risk_push_subscriptions" ON public.team_risk_push_subscriptions;
CREATE POLICY "org_admin_update_team_risk_push_subscriptions"
  ON public.team_risk_push_subscriptions FOR UPDATE
  USING (public.is_org_admin(org_id));

DROP POLICY IF EXISTS "org_admin_delete_team_risk_push_subscriptions" ON public.team_risk_push_subscriptions;
CREATE POLICY "org_admin_delete_team_risk_push_subscriptions"
  ON public.team_risk_push_subscriptions FOR DELETE
  USING (public.is_org_admin(org_id));

CREATE TABLE IF NOT EXISTS public.team_risk_alerts_sent (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  risk_key          TEXT NOT NULL,
  category          TEXT NOT NULL CHECK (category IN ('disclosure', 'action_item', 'deadline')),
  transaction_id    UUID,
  first_alerted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_alerted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, risk_key)
);

COMMENT ON TABLE public.team_risk_alerts_sent IS
  'Dedup ledger for api/cron-hourly-team-risk-alerts.js. One row per still-outstanding risk condition already pushed to the org''s team leads. Deleted by the cron once the condition resolves, so a recurring instance of the SAME condition alerts again rather than being permanently silenced.';

CREATE INDEX IF NOT EXISTS idx_team_risk_alerts_sent_org
  ON public.team_risk_alerts_sent (org_id);

ALTER TABLE public.team_risk_alerts_sent ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_admin_select_team_risk_alerts_sent" ON public.team_risk_alerts_sent;
CREATE POLICY "org_admin_select_team_risk_alerts_sent"
  ON public.team_risk_alerts_sent FOR SELECT
  USING (public.is_org_admin(org_id));

CREATE TABLE IF NOT EXISTS public.team_risk_alert_state (
  org_id              UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  baseline_seeded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.team_risk_alert_state IS
  'One row per org, written on that org''s first-ever api/cron-hourly-team-risk-alerts.js pass. Existence of a row means the baseline backlog has been seeded into team_risk_alerts_sent WITHOUT sending push -- every pass after that alerts on genuinely new conditions only.';

ALTER TABLE public.team_risk_alert_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_admin_select_team_risk_alert_state" ON public.team_risk_alert_state;
CREATE POLICY "org_admin_select_team_risk_alert_state"
  ON public.team_risk_alert_state FOR SELECT
  USING (public.is_org_admin(org_id));
`;

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader =
    (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(SQL);
    return res.status(200).json({
      ok: true,
      message: 'team_risk_push_subscriptions / team_risk_alerts_sent / team_risk_alert_state created (or already existed) with org-admin RLS',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to create team risk push alert tables',
      details: err.message,
    });
  }
};
