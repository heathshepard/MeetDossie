-- Migration: Add supervising_broker_email to profiles table
-- Purpose: IABS (Information About Brokerage Services) prefill is missing the
-- licensed supervisor's email entirely -- 0025-iabs-defaults.sql added
-- supervising_broker_name/license/phone but never supervising_broker_email,
-- so Dossie could never prefill (or a member could never save) that one
-- contact field. Found 2026-10-01 auditing the 702 Fawndale IABS, where the
-- Supervisor row's Email column renders blank on every member's IABS no
-- matter what they enter in Settings, because there was nowhere to store it.
-- See api/esign-create.js getIabsDefaults()/buildIabsPrefill(),
-- api/get-agent-defaults.js, api/save-agent-defaults.js,
-- api/onboarding-extract-profile-defaults.js -- all updated in the same
-- change to read/write this column.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS supervising_broker_email TEXT;
