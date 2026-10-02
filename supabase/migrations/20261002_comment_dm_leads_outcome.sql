-- Brokerage-funnel downstream tracking (Pierce, 2026-10-02, lead-attribution-1002).
--
-- WHY THIS EXISTS
-- `comment_dm_leads` (supabase/migrations/20260925_zernio_comment_engine.sql)
-- is the only queryable record of the TOP of Heath's brokerage/personal-brand
-- funnel: who DM'd a video for an asset, on which platform, for which
-- keyword. Nothing in this database — not here, not anywhere else — records
-- what happens AFTER that: did the person reply, book a call, become a
-- listing or buyer client, or close. That part of the funnel lives entirely
-- in Heath's head, his texts/email, and zipForm/connectMLS once a deal
-- exists, none of which this repo can read.
--
-- This does not claim to automate that tracking — there is no event source
-- that would feed it (a DM reply happening on Instagram's side, a phone call,
-- an in-person meeting are not webhook-able here). What it adds is somewhere
-- to put the answer BY HAND once Heath or Pierce knows it, so "did this lead
-- produce business" stops being unknowable-forever and becomes a 10-second
-- manual update per lead that's worth following up on. Per
-- docs/WEEKLY-MARKETING-PLAN.md's existing Friday "expansion + referral"
-- motion, this is exactly the kind of thing that cadence already checks for
-- manually — now there's a column for the answer to live in.
--
-- No PII requirement beyond what comment_dm_leads already carries
-- (commenter_name/commenter_handle, a platform identity, not a legal name or
-- contact detail) — outcome_notes is free text Heath/Pierce fill in by hand
-- and should stay to platform-identifiable facts (e.g. "booked a call
-- 10/5"), not anything that wouldn't already be fine next to a public
-- Instagram handle.
--
-- Additive, nullable, no backfill — same pattern as every other migration in
-- this batch. NOT APPLIED as part of this branch/PR; apply via
-- api/admin-migrate-comment-dm-leads-outcome.js once Heath reviews it.

ALTER TABLE public.comment_dm_leads
  ADD COLUMN IF NOT EXISTS outcome TEXT,
  ADD COLUMN IF NOT EXISTS outcome_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS outcome_notes TEXT;

ALTER TABLE public.comment_dm_leads
  DROP CONSTRAINT IF EXISTS comment_dm_leads_outcome_chk;
ALTER TABLE public.comment_dm_leads
  ADD CONSTRAINT comment_dm_leads_outcome_chk
  CHECK (outcome IS NULL OR outcome IN ('replied', 'appointment_booked', 'listing_agreement', 'buyer_agreement', 'closed', 'dead'));

CREATE INDEX IF NOT EXISTS idx_comment_dm_leads_outcome
  ON public.comment_dm_leads (outcome)
  WHERE outcome IS NOT NULL;

COMMENT ON COLUMN public.comment_dm_leads.outcome IS
  'Manually logged by Heath/Pierce — there is no automated event source for any stage past the DM itself. NULL means "not yet known or not yet followed up," not "no outcome." One of: replied, appointment_booked, listing_agreement, buyer_agreement, closed, dead.';
COMMENT ON COLUMN public.comment_dm_leads.outcome_at IS
  'When the outcome above was logged, not necessarily when it actually happened — set by whoever updates the row.';
COMMENT ON COLUMN public.comment_dm_leads.outcome_notes IS
  'Free text, manual. Keep to platform-identifiable facts already implied by commenter_handle being public — do not add anything that would not already be fine sitting next to a public handle.';
