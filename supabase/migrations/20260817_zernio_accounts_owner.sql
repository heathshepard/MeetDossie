-- Support two independent Facebook destinations under the same platform
-- value: Dossie's Page (@meetdossie) and Heath's personal realtor Page
-- (facebook.com/HeathShepardRealtor). Today `zernio_accounts` is keyed only
-- by platform, so `platform='facebook'` is ambiguous the moment a second
-- Facebook destination exists.
--
-- Adds an `owner` column identifying which destination a row belongs to.
-- Existing rows default to 'dossie' so cron-generate-posts.js and
-- cron-coverage-check.js — which call lookupZernioAccountId(platform) with
-- no owner argument — keep resolving exactly as before. Zero behavior
-- change until a 'heath-realtor' row is inserted.
--
-- Context: Zernio's current Facebook OAuth grant covers @meetdossie only
-- (zernio_accounts id 9dcd79ef-dc29-4ed1-96bf-52b1210a0760,
-- zernio_account_id 69f253c3985e734bf3d8f9bc). Heath must do a manual OAuth
-- re-auth click on Zernio's dashboard to grant access to the realtor Page —
-- human-only step, not automatable. This migration only prepares the
-- schema for that row. See scripts/finish-realtor-page-zernio-setup.js for
-- the insert once the real zernio_account_id is known.

ALTER TABLE public.zernio_accounts
  ADD COLUMN IF NOT EXISTS owner text NOT NULL DEFAULT 'dossie';

ALTER TABLE public.zernio_accounts
  DROP CONSTRAINT IF EXISTS zernio_accounts_owner_check;

ALTER TABLE public.zernio_accounts
  ADD CONSTRAINT zernio_accounts_owner_check
  CHECK (owner IN ('dossie', 'heath-realtor'));

-- One active connected account per (platform, owner) pair. Confirmed via
-- PostgREST's OpenAPI schema (2026-08-17) that no pre-existing unique
-- constraint on platform alone would block a second facebook row.
DROP INDEX IF EXISTS idx_zernio_accounts_platform_owner_active;
CREATE UNIQUE INDEX idx_zernio_accounts_platform_owner_active
  ON public.zernio_accounts (platform, owner)
  WHERE is_active = true;

COMMENT ON COLUMN public.zernio_accounts.owner IS
  'Which destination this connected account belongs to: dossie (the product Page/handles) or heath-realtor (Heath''s personal facebook.com/HeathShepardRealtor Page). Combined with platform to disambiguate two Facebook destinations.';
