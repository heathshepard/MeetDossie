-- 20260711_contract_verification_events.sql
--
-- Phase 1 Interactive Form Editor — legal trail.
--
-- Records every "I've reviewed this document and confirm the fields are
-- correct" acknowledgement an agent makes before sending a contract for
-- signature. Queryable proof of exactly what the agent saw + accepted at
-- the moment they hit Accept.
--
-- Also adds trec_effective_date to form_templates so the version banner
-- ("TREC 20-19 · Effective 07/01/2026") auto-populates from the DB
-- instead of being hardcoded in the client.
--
-- CARTER draft 2026-07-11. Not yet applied — Atlas applies during ship.

CREATE TABLE IF NOT EXISTS public.contract_verification_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id        UUID NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  form_template_id      UUID REFERENCES public.form_templates(id) ON DELETE SET NULL,
  template_id           TEXT,                       -- DocuSeal template id (e.g. '4952172')
  trec_form_number      TEXT,                       -- e.g. '20-19'
  contract_version      TEXT,                       -- e.g. '20-19 rev 07/01/2026'
  verified_by           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  verified_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pdf_hash              TEXT,                       -- sha256 of the PDF the agent accepted
  pdf_storage_path      TEXT,                       -- Supabase storage path to snapshot PDF
  field_values_snapshot JSONB NOT NULL DEFAULT '{}',-- full { field_key: value } object at accept time
  signer_emails         JSONB NOT NULL DEFAULT '[]',-- [{ role, email, name }, ...]
  user_agent            TEXT,
  client_ip             TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cve_transaction ON public.contract_verification_events(transaction_id);
CREATE INDEX IF NOT EXISTS idx_cve_verified_by ON public.contract_verification_events(verified_by);
CREATE INDEX IF NOT EXISTS idx_cve_verified_at ON public.contract_verification_events(verified_at DESC);

ALTER TABLE public.contract_verification_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_read"   ON public.contract_verification_events
  FOR SELECT USING (auth.uid() = verified_by);
CREATE POLICY "owner_insert" ON public.contract_verification_events
  FOR INSERT WITH CHECK (auth.uid() = verified_by);
CREATE POLICY "service_all"  ON public.contract_verification_events
  FOR ALL USING (auth.role() = 'service_role');

-- Version banner support.
ALTER TABLE public.form_templates
  ADD COLUMN IF NOT EXISTS trec_effective_date DATE;

-- Seed the current TREC 20-19 effective date so the banner reads correctly
-- from day one. TREC published 20-19 with an effective date of 2026-07-01.
UPDATE public.form_templates
   SET trec_effective_date = DATE '2026-07-01'
 WHERE trec_number = '20-19';

-- Also register the 20-19 form_template row if it isn't in the library yet.
-- Idempotent — NOOP if it's already there.
INSERT INTO public.form_templates (name, short_name, category, trec_number, description, is_active, trec_effective_date)
SELECT
  'One to Four Family Residential Contract (Resale)',
  '1-4 Family Contract',
  'contract',
  '20-19',
  'TREC 20-19 — Resale residential contract, effective 07/01/2026.',
  TRUE,
  DATE '2026-07-01'
WHERE NOT EXISTS (
  SELECT 1 FROM public.form_templates WHERE trec_number = '20-19'
);
