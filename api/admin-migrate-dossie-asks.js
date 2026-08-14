// One-time migration: create public.dossie_asks (the "Dossie asks" action-card
// feed on the app home page — see supabase/migrations/20260814_dossie_asks.sql
// for the full design commentary).
//
// Safe to re-run — every statement is IF NOT EXISTS / OR REPLACE /
// DROP-then-CREATE. No data is touched.
//
// This route exists because POSTGRES_URL_NON_POOLING is a write-only
// ("Sensitive") Vercel var, so DDL cannot be run from a local shell — the
// pulled value is the literal [SENSITIVE]. Same reason the admin-migrate-*
// siblings exist.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-08-14 (SV-ENG-DOSSIE-ASKS)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
CREATE TABLE IF NOT EXISTS public.dossie_asks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_id    UUID REFERENCES public.transactions(id) ON DELETE CASCADE,
  urgency           TEXT NOT NULL DEFAULT 'normal'
                      CHECK (urgency IN ('critical', 'high', 'normal', 'low')),
  title             TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  body              TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  due_at            TIMESTAMPTZ,
  due_label         TEXT,
  suggested_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  thread            JSONB NOT NULL DEFAULT '[]'::jsonb,
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'snoozed', 'resolved', 'dismissed')),
  resolution        TEXT,
  resolution_note   TEXT,
  resolved_at       TIMESTAMPTZ,
  snoozed_until     TIMESTAMPTZ,
  created_by        TEXT NOT NULL DEFAULT 'dossie'
                      CHECK (created_by IN ('dossie', 'system', 'agent')),
  source            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.dossie_asks IS
  'Persistent, prioritized action cards shown at the top of the app home page. Each row survives until resolved/dismissed -- deliberately not a chat log, so deal-critical asks cannot scroll away unanswered.';
COMMENT ON COLUMN public.dossie_asks.body IS
  'The ask in plain language INCLUDING the consequence of inaction, not just the fact.';
COMMENT ON COLUMN public.dossie_asks.suggested_actions IS
  'JSON array of 2-3 quick actions: [{id,label,kind}].';
COMMENT ON COLUMN public.dossie_asks.thread IS
  'Replies captured against this specific card, newest last.';
COMMENT ON COLUMN public.dossie_asks.status IS
  'open | snoozed | resolved | dismissed. Only open (and snoozed past snoozed_until) rows are surfaced.';

CREATE INDEX IF NOT EXISTS idx_dossie_asks_feed
  ON public.dossie_asks (user_id, status, due_at NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_dossie_asks_transaction
  ON public.dossie_asks (transaction_id)
  WHERE transaction_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.dossie_asks_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dossie_asks_touch_updated_at ON public.dossie_asks;
CREATE TRIGGER trg_dossie_asks_touch_updated_at
  BEFORE UPDATE ON public.dossie_asks
  FOR EACH ROW EXECUTE FUNCTION public.dossie_asks_touch_updated_at();

ALTER TABLE public.dossie_asks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own dossie_asks" ON public.dossie_asks;
CREATE POLICY "Users can view their own dossie_asks"
  ON public.dossie_asks FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert their own dossie_asks" ON public.dossie_asks;
CREATE POLICY "Users can insert their own dossie_asks"
  ON public.dossie_asks FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update their own dossie_asks" ON public.dossie_asks;
CREATE POLICY "Users can update their own dossie_asks"
  ON public.dossie_asks FOR UPDATE
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete their own dossie_asks" ON public.dossie_asks;
CREATE POLICY "Users can delete their own dossie_asks"
  ON public.dossie_asks FOR DELETE
  USING ((select auth.uid()) = user_id);
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
      message: 'dossie_asks table created (or already existed) with per-user RLS',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to create dossie_asks',
      details: err.message,
    });
  }
};
