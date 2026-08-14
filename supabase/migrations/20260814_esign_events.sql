-- ============================================================================
-- esign_events — signature activity detected from inbound provider email.
--
-- WHY EMAIL: Authentisign (Lone Wolf / zipForm) is the provider Heath actually
-- signs through, and it exposes no webhook to us. The only signal we get is the
-- notification email ("Signing updated... Action: Document Accepted,
-- Participant: Thomas Linton", then "Signing complete: ..."). DocuSeal and
-- DocuSign DO have webhooks (see api/esign-webhook.js for the DocuSeal one),
-- but only for envelopes WE originated. A packet the agent sent from zipForm is
-- invisible to us except through the inbox. So the inbox is the source.
--
-- WHY A TABLE AND NOT notes_log: cron-email-to-dossier.js drops an AI summary
-- into transactions.notes_log, which is right for correspondence and wrong for
-- this. A signature event has structured state we have to act on and not
-- re-act on: which participant, what action, whether we already pulled the
-- executed PDF, and whether the signatures actually rendered. That needs
-- columns and a dedupe key, not prose in a jsonb array.
--
-- THE EXPIRING-LINK PROBLEM: Authentisign download links die after 7 days. The
-- provider is not a system of record. document_id points at our own durable
-- copy in Supabase Storage; document_url is kept only for audit and is expected
-- to rot.
--
-- Owner: Carter, 2026-08-14 (SV-ENG-ESIGN-COMPLETION)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.esign_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Nullable: we log the event even when we cannot confidently match a deal,
  -- so an unmatched signing is visible rather than silently dropped.
  transaction_id     UUID REFERENCES public.transactions(id) ON DELETE SET NULL,

  provider           TEXT NOT NULL DEFAULT 'unknown'
                       CHECK (provider IN ('authentisign', 'docusign', 'docuseal', 'adobesign', 'unknown')),

  document_name      TEXT,
  participant_name   TEXT,
  participant_email  TEXT,

  -- Normalized across providers. 'completed' is the one that triggers
  -- retrieval + verification.
  action             TEXT NOT NULL DEFAULT 'other'
                       CHECK (action IN ('sent', 'viewed', 'accepted', 'signed', 'completed', 'declined', 'cancelled', 'other')),

  event_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Provenance + dedupe. One Gmail message produces exactly one event row.
  source_message_id  TEXT NOT NULL,
  source_thread_id   TEXT,
  subject            TEXT,
  snippet            TEXT,

  -- The provider's download link. EXPECTED TO EXPIRE (7 days on Authentisign).
  -- Audit value only — never treat as the copy of record.
  document_url       TEXT,

  -- Our durable copy. This is the copy of record.
  document_id        UUID REFERENCES public.documents(id) ON DELETE SET NULL,

  -- Signature verification result (see api/_lib/signature-verifier.js).
  -- verdict: signed | partially_signed | blank | unverifiable
  verification_verdict TEXT
                       CHECK (verification_verdict IS NULL OR verification_verdict IN
                         ('signed', 'partially_signed', 'blank', 'unverifiable')),
  verification         JSONB,
  -- SHA-256 of the exact bytes we filed, for the legal trail.
  document_sha256      TEXT,

  -- Set once we have raised the corresponding dossie_asks card, so a retry
  -- never produces duplicate cards.
  ask_id             UUID REFERENCES public.dossie_asks(id) ON DELETE SET NULL,

  processed_at       TIMESTAMPTZ,
  process_error      TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.esign_events IS
  'Signature activity parsed from inbound e-signature provider notification emails (Authentisign has no webhook). One row per source email.';
COMMENT ON COLUMN public.esign_events.document_url IS
  'Provider download link. Authentisign links expire after 7 days — audit only, never the copy of record. document_id is the durable copy.';
COMMENT ON COLUMN public.esign_events.verification_verdict IS
  'Result of actually looking at the rendered pages. Anything other than "signed" must surface to the agent — provider status is not evidence.';

-- One event per source email. This is the dedupe guarantee the cron relies on.
CREATE UNIQUE INDEX IF NOT EXISTS idx_esign_events_source_msg
  ON public.esign_events (user_id, source_message_id);

CREATE INDEX IF NOT EXISTS idx_esign_events_transaction
  ON public.esign_events (transaction_id, event_at DESC)
  WHERE transaction_id IS NOT NULL;

-- The "needs attention" query: completions that did not verify clean.
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

-- ---------------------------------------------------------------------------
-- RLS — per-agent, same shape as dossie_asks (customer-facing, multi-tenant).
-- Writes come from service_role (the cron), which bypasses RLS.
-- ---------------------------------------------------------------------------
ALTER TABLE public.esign_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own esign_events"   ON public.esign_events;
DROP POLICY IF EXISTS "Users can update their own esign_events" ON public.esign_events;

CREATE POLICY "Users can view their own esign_events"
  ON public.esign_events FOR SELECT
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can update their own esign_events"
  ON public.esign_events FOR UPDATE
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
