-- Multi-user isolation fix — schema additions for the Settings page.
-- Run once in Supabase Studio → SQL Editor.
--
-- Adds the `license_number` column (settings UI exposes it; Texas TREC#).
-- Presentation prefs (brand_line, brief_subtitle, email_client) live inside
-- the existing `custom_fit` JSONB column — no schema change needed for those.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS license_number TEXT;

-- Sanity check.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'profiles'
  AND column_name  = 'license_number';
