-- ============================================================================
-- Fix: transaction_offers_status_check rejected 'retired'.
--
-- Found by LIVE verification of retire_offer against a real demo offer, not
-- by the earlier PostgREST OpenAPI introspection pull — that method doesn't
-- surface every CHECK constraint shape, and this one wasn't visible in the
-- definitions.transaction_offers.properties.status output (no `enum` key),
-- which is what led the prior migration's comment to say "no DB-level CHECK
-- constraint found." It exists: transaction_offers_status_check, currently
-- CHECK (status IN ('pending','accepted','rejected','countered')). Confirmed
-- via the actual 23514 constraint-violation error retire_offer hit live:
-- "new row for relation transaction_offers violates check constraint
-- transaction_offers_status_check".
--
-- Lesson for next time: OpenAPI introspection is a good first pass, not a
-- substitute for exercising the real write path before trusting a schema
-- assumption.
--
-- Owner: Carter, 2026-09-21.
-- ============================================================================

ALTER TABLE public.transaction_offers
  DROP CONSTRAINT IF EXISTS transaction_offers_status_check;

ALTER TABLE public.transaction_offers
  ADD CONSTRAINT transaction_offers_status_check
  CHECK (status IN ('pending', 'accepted', 'rejected', 'countered', 'retired'));
