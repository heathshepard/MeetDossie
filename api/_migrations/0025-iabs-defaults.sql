-- Migration: Add IABS agent defaults to profiles table
-- Purpose: Support progressive profiling for IABS (Information About Brokerage Services)
-- Locked: 2026-07-14 - Heath approved progressive profiling approach

-- Add columns to profiles table for IABS broker info
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS broker_name TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS broker_license_number TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS broker_phone TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS broker_email TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS broker_address_street TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS broker_address_city TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS broker_address_state TEXT DEFAULT 'TX';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS broker_address_zip TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS supervising_broker_name TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS supervising_broker_license TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS supervising_broker_phone TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS agent_license_number TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS agent_phone TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS agent_relationship_type TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS iabs_defaults_completed BOOLEAN DEFAULT FALSE;

-- Add index for iabs_defaults_completed to speed up filtering
CREATE INDEX IF NOT EXISTS idx_profiles_iabs_completed ON public.profiles(iabs_defaults_completed);

-- RLS policies: self-read (user can read own profile), self-update (user can update own profile)
-- These are already in place from the existing profiles table setup.
-- No new policies needed - existing owner_read/owner_update policies cover the new columns.
