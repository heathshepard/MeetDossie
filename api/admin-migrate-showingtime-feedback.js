// One-time migration: create public.showingtime_feedback. Full design
// commentary in supabase/migrations/20260822_showingtime_feedback.sql.
//
// Safe to re-run — every statement is IF NOT EXISTS / OR REPLACE. No data is
// touched.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-08-22 (SV-ENG-EMAIL-INTEGRATION-ADDON)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
CREATE TABLE IF NOT EXISTS public.showingtime_feedback (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_id     UUID REFERENCES public.transactions(id) ON DELETE SET NULL,
  property_address   TEXT,
  showing_agent_name TEXT,
  showing_agent_email TEXT,
  showing_date       TIMESTAMPTZ,
  rating             TEXT,
  feedback_text       TEXT,
  source_message_id  TEXT NOT NULL,
  source_thread_id   TEXT,
  subject            TEXT,
  filed              BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.showingtime_feedback IS
  'Parsed ShowingTime feedback-notification emails, one row per email. Feeds the weekly listing-performance digest and files a note into the matched transaction (if any).';

CREATE UNIQUE INDEX IF NOT EXISTS idx_showingtime_feedback_source_msg
  ON public.showingtime_feedback (user_id, source_message_id);

CREATE INDEX IF NOT EXISTS idx_showingtime_feedback_transaction
  ON public.showingtime_feedback (transaction_id, showing_date DESC)
  WHERE transaction_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.showingtime_feedback_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_showingtime_feedback_touch_updated_at ON public.showingtime_feedback;
CREATE TRIGGER trg_showingtime_feedback_touch_updated_at
  BEFORE UPDATE ON public.showingtime_feedback
  FOR EACH ROW EXECUTE FUNCTION public.showingtime_feedback_touch_updated_at();

ALTER TABLE public.showingtime_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own showingtime_feedback" ON public.showingtime_feedback;
CREATE POLICY "Users can view their own showingtime_feedback"
  ON public.showingtime_feedback FOR SELECT
  USING ((select auth.uid()) = user_id);
`;

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(SQL);
    return res.status(200).json({ ok: true, message: 'showingtime_feedback table created (or already existed) with per-user RLS' });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({ ok: false, error: 'Failed to create showingtime_feedback', details: err.message });
  }
};
