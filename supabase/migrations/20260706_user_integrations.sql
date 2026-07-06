-- 2026-07-06 ATLAS — user_integrations table for OAuth tokens (Google Calendar / Gmail).
--
-- Stores per-user OAuth refresh_token + access_token + expiry per provider.
-- Read/refreshed by /api/jarvis-calendar and future gmail integrations.
-- Written by /api/google-oauth-callback after Google exchange.
--
-- Schema matches columns referenced by api/jarvis-calendar.js findGoogleIntegration():
--   oauth_provider (text), refresh_token (text), access_token (text), scopes (text), expires_at (timestamptz)

CREATE TABLE IF NOT EXISTS public.user_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  oauth_provider text NOT NULL,           -- 'google_calendar' | 'google_gmail' | future
  access_token text,                       -- short-lived, refreshed on demand
  refresh_token text,                      -- long-lived, required for offline access
  scopes text,                             -- space-separated OAuth scopes granted
  expires_at timestamptz,                  -- access_token expiry
  google_email text,                       -- the connected Google account email
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, oauth_provider)
);

CREATE INDEX IF NOT EXISTS user_integrations_user_id_idx
  ON public.user_integrations(user_id);

CREATE INDEX IF NOT EXISTS user_integrations_provider_idx
  ON public.user_integrations(oauth_provider);

COMMENT ON TABLE public.user_integrations IS
  'OAuth tokens for third-party integrations (Google Calendar, Gmail, etc). Written by /api/google-oauth-callback, read by /api/jarvis-calendar and similar.';

-- oauth state tokens — short-lived, one-shot, used to bind /oauth-init state to /oauth-callback
CREATE TABLE IF NOT EXISTS public.oauth_states (
  state text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  redirect_after text,                     -- optional post-callback client redirect
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS oauth_states_expires_idx
  ON public.oauth_states(expires_at);

COMMENT ON TABLE public.oauth_states IS
  'CSRF-mitigation state tokens for OAuth init/callback handoff. TTL 15 minutes.';

-- RLS: user_integrations — a user can read/delete their own integration rows.
-- Writes only via service role (from /api/google-oauth-callback).
ALTER TABLE public.user_integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_integrations_self_select" ON public.user_integrations;
CREATE POLICY "user_integrations_self_select"
  ON public.user_integrations FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_integrations_self_delete" ON public.user_integrations;
CREATE POLICY "user_integrations_self_delete"
  ON public.user_integrations FOR DELETE
  USING (auth.uid() = user_id);

-- oauth_states: service-role only (no client access; only backend endpoints touch it)
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;
-- No client policies — service role bypasses RLS.
