-- Migration: per-member integrations connect/health + connections wizard flag.
-- Carter, 2026-10-01 (member integrations + setup wizard build).
--
-- 1. user_integrations gets a DocuSeal lane (no OAuth flow — a member
--    pastes their own DocuSeal API key, generated in their own DocuSeal
--    account, validated live against DocuSeal's API before it's ever
--    stored) plus generic cached-health columns used by every provider
--    (google_gmail / microsoft_graph / docuseal) so the Connections UI
--    doesn't have to make a live call on every page load.
--
--    docuseal_api_key_encrypted is NEVER plaintext — see
--    api/_lib/secret-crypto.js (AES-256-GCM, key in Vercel env
--    INTEGRATION_ENCRYPTION_KEY, never committed).
--
-- 2. profiles gets a "has this member seen/finished the Connections setup
--    wizard" flag, separate from iabs_defaults_completed — same modal
--    flow (continuous, not competing), different step, different data.

ALTER TABLE public.user_integrations ADD COLUMN IF NOT EXISTS docuseal_api_key_encrypted TEXT;
ALTER TABLE public.user_integrations ADD COLUMN IF NOT EXISTS docuseal_account_email TEXT;
ALTER TABLE public.user_integrations ADD COLUMN IF NOT EXISTS last_check_status TEXT;
ALTER TABLE public.user_integrations ADD COLUMN IF NOT EXISTS last_check_detail TEXT;
ALTER TABLE public.user_integrations ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_integrations_last_check_status_check'
  ) THEN
    ALTER TABLE public.user_integrations
      ADD CONSTRAINT user_integrations_last_check_status_check
      CHECK (last_check_status IS NULL OR last_check_status IN (
        'connected', 'expired', 'error', 'never_connected'
      ));
  END IF;
END $$;

COMMENT ON COLUMN public.user_integrations.docuseal_api_key_encrypted IS
  'AES-256-GCM-encrypted DocuSeal API key for oauth_provider=docuseal rows
   (api/_lib/secret-crypto.js). Never plaintext, never logged. Written by
   api/integrations-docuseal-connect.js only after a live validation call
   (api/_lib/docuseal-health.js) confirms the key actually authenticates.';
COMMENT ON COLUMN public.user_integrations.docuseal_account_email IS
  'Best-effort label for the connected DocuSeal account, shown in the
   Connections UI. DocuSeal''s API key endpoint does not reliably return an
   account email, so this is frequently NULL — UI falls back to "Connected".';
COMMENT ON COLUMN public.user_integrations.last_check_status IS
  'Cached outcome of the most recent on-demand health check
   (api/integrations-check.js), one of connected/expired/error/never_connected.
   Lets the Connections UI render instantly from cache and only re-probe the
   live provider when the member clicks "Check connection" or opens the wizard.';
COMMENT ON COLUMN public.user_integrations.last_check_detail IS
  'Human-readable reason for the last_check_status, safe to show a member
   (never contains a token/secret — see each provider health module).';

-- No RLS change: user_integrations already has self_select (auth.uid() =
-- user_id) and self_delete; every WRITE to this table (including the new
-- DocuSeal columns) still goes exclusively through service-role API
-- endpoints, same as every existing Google/Microsoft write path.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS connections_wizard_completed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS connections_wizard_completed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.profiles.connections_wizard_completed IS
  'True once the member has clicked through (or explicitly skipped) the
   Connections setup wizard (Email + DocuSeal). Drives the
   showConnectionsWizard auto-open in dossie-app.jsx, chained after the
   existing IABS defaults wizard — same pattern as iabs_defaults_completed.';

-- No RLS change: existing profiles owner_read/owner_update policies already
-- cover new columns (same note as prior profiles migrations).
