// One-time migration for
// supabase/migrations/20260930d_onboarding_defaults_extraction.sql — see
// that file for the full column/table writeup. Runs through the same
// direct-Postgres connection every admin-migrate-*.js route uses, since
// PostgREST (SUPABASE_URL) cannot run DDL.
//
// Safe to re-run — every ALTER uses IF NOT EXISTS / guarded constraint
// checks, the CREATE TABLE uses IF NOT EXISTS, and policies are
// DROP-then-CREATE.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-30

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS team_name TEXT;

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

ALTER TABLE public.onboarding_document_extractions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS onboarding_extractions_owner_select ON public.onboarding_document_extractions;
CREATE POLICY onboarding_extractions_owner_select ON public.onboarding_document_extractions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS onboarding_extractions_service_all ON public.onboarding_document_extractions;
CREATE POLICY onboarding_extractions_service_all ON public.onboarding_document_extractions
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
`;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(SQL);
    return res.status(200).json({
      ok: true,
      message: 'onboarding defaults extraction migration applied: profiles.team_name + designated_broker_* + license_validation_* columns, onboarding_document_extractions table + RLS created.',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to run onboarding-defaults-extraction migration',
      details: err.message,
    });
  }
};
