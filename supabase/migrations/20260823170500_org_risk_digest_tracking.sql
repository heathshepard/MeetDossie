-- =============================================================================
-- Weekly team risk digest: idempotency tracking column.
--
-- api/cron-weekly-team-risk-digest.js emails each active Team/Brokerage org's
-- founder a factual weekly rollup (missing disclosures, overdue action items,
-- deadline drift) sourced from api/_lib/team-risk-rollup.js. This column lets
-- the cron skip an org it already emailed within the last 6 days, so a manual
-- re-trigger (or a Vercel cron retry) the same week doesn't double-send.
--
-- Additive only — no other table/column touched.
-- =============================================================================

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS last_risk_digest_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN public.organizations.last_risk_digest_sent_at IS
  'Last time api/cron-weekly-team-risk-digest.js successfully emailed this org''s founder. NULL = never sent.';
