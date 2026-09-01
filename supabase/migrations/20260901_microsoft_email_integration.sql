-- 2026-09-01 CARTER — Microsoft Graph support for the Email Integration add-on.
--
-- Mirrors the existing google_email column. oauth_provider already accepts
-- any text value (no enum, no schema change needed there) — this adds the
-- one new column api/microsoft-oauth-callback.js writes to and
-- api/_lib/microsoft-oauth.js reads from. New rows use
-- oauth_provider = 'microsoft_graph'.

ALTER TABLE public.user_integrations
  ADD COLUMN IF NOT EXISTS microsoft_email text;

COMMENT ON COLUMN public.user_integrations.microsoft_email IS
  'The connected Microsoft 365 / Outlook.com account email, for oauth_provider=microsoft_graph rows. Written by api/microsoft-oauth-callback.js.';
