// One-time migration: create public.esign_events — signature activity parsed
// from inbound e-signature provider notification emails. Full design
// commentary in supabase/migrations/20260814_esign_events.sql.
//
// Safe to re-run — every statement is IF NOT EXISTS / OR REPLACE /
// DROP-then-CREATE. No data is touched.
//
// Exists for the same reason as its admin-migrate-* siblings:
// POSTGRES_URL_NON_POOLING is a write-only ("Sensitive") Vercel var, so the
// locally pulled value is the literal [SENSITIVE] and DDL cannot be run from a
// shell.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-08-14 (SV-ENG-ESIGN-COMPLETION)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
CREATE TABLE IF NOT EXISTS public.esign_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_id     UUID REFERENCES public.transactions(id) ON DELETE SET NULL,
  provider           TEXT NOT NULL DEFAULT 'unknown'
                       CHECK (provider IN ('authentisign', 'docusign', 'docuseal', 'adobesign', 'unknown')),
  document_name      TEXT,
  participant_name   TEXT,
  participant_email  TEXT,
  action             TEXT NOT NULL DEFAULT 'other'
                       CHECK (action IN ('sent', 'viewed', 'accepted', 'signed', 'completed', 'declined', 'cancelled', 'other')),
  event_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_message_id  TEXT NOT NULL,
  source_thread_id   TEXT,
  subject            TEXT,
  snippet            TEXT,
  document_url       TEXT,
  document_id        UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  verification_verdict TEXT
                       CHECK (verification_verdict IS NULL OR verification_verdict IN
                         ('signed', 'partially_signed', 'blank', 'unverifiable')),
  verification         JSONB,
  document_sha256      TEXT,
  ask_id             UUID REFERENCES public.dossie_asks(id) ON DELETE SET NULL,
  processed_at       TIMESTAMPTZ,
  process_error      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.esign_events IS
  'Signature activity parsed from inbound e-signature provider notification emails (Authentisign has no webhook). One row per source email.';
COMMENT ON COLUMN public.esign_events.document_url IS
  'Provider download link. Authentisign links expire after 7 days -- audit only, never the copy of record. document_id is the durable copy.';
COMMENT ON COLUMN public.esign_events.verification_verdict IS
  'Result of actually looking at the rendered pages. Anything other than "signed" must surface to the agent -- provider status is not evidence.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_esign_events_source_msg
  ON public.esign_events (user_id, source_message_id);

CREATE INDEX IF NOT EXISTS idx_esign_events_transaction
  ON public.esign_events (transaction_id, event_at DESC)
  WHERE transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_esign_events_bad_verdict
  ON public.esign_events (user_id, verification_verdict)
  WHERE verification_verdict IS NOT NULL AND verification_verdict <> 'signed';

CREATE OR REPLACE FUNCTION public.esign_events_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_esign_events_touch_updated_at ON public.esign_events;
CREATE TRIGGER trg_esign_events_touch_updated_at
  BEFORE UPDATE ON public.esign_events
  FOR EACH ROW EXECUTE FUNCTION public.esign_events_touch_updated_at();

ALTER TABLE public.esign_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own esign_events" ON public.esign_events;
CREATE POLICY "Users can view their own esign_events"
  ON public.esign_events FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update their own esign_events" ON public.esign_events;
CREATE POLICY "Users can update their own esign_events"
  ON public.esign_events FOR UPDATE
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
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
      message: 'esign_events table created (or already existed) with per-user RLS',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to create esign_events',
      details: err.message,
    });
  }
};
