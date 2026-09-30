-- Migration: onboarding "upload a past transaction -> agent defaults" feature
-- Carter, 2026-09-30.
--
-- Extends the existing IABS-defaults columns (api/_migrations/0025-iabs-defaults.sql,
-- live since 2026-07-14) rather than creating a parallel schema. Adds:
--   1. profiles.team_name — the one field the existing IABS defaults form
--      doesn't have yet (team name isn't a "broker" field, it's the agent's own).
--   2. TREC validation tracking columns on profiles, so a saved default carries
--      when/whether it was checked against TREC's public license record.
--   3. onboarding_document_extractions — an audit-only log proving what the
--      extraction step did WITHOUT retaining any of the uploaded document's
--      content. No PDF bytes, no storage_path, no third-party names/prices —
--      only which field KEYS were found and the TREC validation outcome for
--      the agent's own license numbers. This is the evidence trail for "we
--      read it once and threw it away."

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS team_name TEXT;

-- TREC's IABS form (IABS 1-0) lists FOUR distinct roles on one page:
--   1. Licensed Broker /Broker Firm Name + License No.  -> broker_name / broker_license_number (already existed)
--   2. Designated Broker of Firm + License No.           -> designated_broker_name / designated_broker_license (NEW)
--   3. Licensed Supervisor of Sales Agent/Associate       -> supervising_broker_name / supervising_broker_license (already existed)
--   4. Sales Agent/Associate's Name                       -> the member themself (profiles.full_name / agent_license_number)
-- Roles 2 and 3 are frequently different people and were being conflated
-- before this feature existed — see docs referenced in the onboarding
-- extraction PR: Heath's own zipForm carried the wrong person in the
-- supervisor slot. Giving role 2 its own column stops the extraction UI
-- from having to guess which field a "Designated Broker" line maps to.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS designated_broker_name TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS designated_broker_license TEXT;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS license_validation_status TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS license_validation_checked_at TIMESTAMPTZ;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS license_validation_notes JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_license_validation_status_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_license_validation_status_check
      CHECK (license_validation_status IS NULL OR license_validation_status IN (
        'verified', 'mismatch', 'name_mismatch', 'inactive', 'not_found', 'skipped', 'not_checked'
      ));
  END IF;
END $$;

COMMENT ON COLUMN public.profiles.license_validation_status IS
  'Result of the last TREC public-license cross-check run against this
   profile''s saved defaults (api/_lib/trec-license-lookup.js). Set by
   api/onboarding-extract-profile-defaults.js at extraction time and by any
   future re-validation. NULL/not_checked = never validated (e.g. entered
   manually in Settings before this feature existed).';
COMMENT ON COLUMN public.profiles.license_validation_notes IS
  'Small JSON summary of the last TREC check: which fields were checked,
   what TREC returned (current sponsor license, active/inactive), and the
   human-readable mismatch detail shown in Settings. Never contains PDF
   content or third-party data — only the agent''s own license facts.';

-- No RLS change needed: existing profiles owner_read/owner_update policies
-- already cover new columns (same note as 0025-iabs-defaults.sql).

CREATE TABLE IF NOT EXISTS public.onboarding_document_extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_document_types TEXT[] NOT NULL DEFAULT '{}',
  fields_found TEXT[] NOT NULL DEFAULT '{}',
  fields_confirmed TEXT[] NOT NULL DEFAULT '{}',
  trec_validation_summary JSONB,
  documents_retained BOOLEAN NOT NULL DEFAULT FALSE
);

COMMENT ON TABLE public.onboarding_document_extractions IS
  'Audit-only record of an onboarding defaults-extraction run. Deliberately
   holds NO document content: no PDF bytes, no storage_path, no filename, no
   third-party names/addresses/prices. Only field KEYS (e.g.
   "supervising_broker_license"), not values, plus the TREC validation
   outcome for the member''s own license numbers. documents_retained is
   always FALSE by construction — api/onboarding-extract-profile-defaults.js
   never writes the uploaded PDF anywhere; this column exists so that fact is
   queryable/auditable rather than only true by code inspection.';

ALTER TABLE public.onboarding_document_extractions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS onboarding_extractions_owner_select ON public.onboarding_document_extractions;
CREATE POLICY onboarding_extractions_owner_select ON public.onboarding_document_extractions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS onboarding_extractions_service_all ON public.onboarding_document_extractions;
CREATE POLICY onboarding_extractions_service_all ON public.onboarding_document_extractions
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- No owner INSERT/UPDATE/DELETE policy — this table is written only by the
-- server (service_role) via api/onboarding-extract-profile-defaults.js, same
-- "server writes, member reads own rows" pattern as post_analytics.
