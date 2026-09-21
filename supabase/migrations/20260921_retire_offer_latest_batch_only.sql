-- ============================================================================
-- Fix: retire_offer broke on a re-accepted offer (a real sequence — a buyer
-- retires, then comes back and re-accepts the same offer row later).
--
-- Found live testing the accept -> retire -> accept-a-backup chain: accepting
-- an offer that was PREVIOUSLY accepted-then-retired is allowed by design
-- (accept_offer's idempotency guard only blocks re-running on a CURRENTLY
-- 'accepted' offer, not a 'retired' one — re-accepting after a fall-through
-- is a legitimate real-world path). But each accept_offer call inserts a
-- FRESH batch of 17 offer_field_snapshots rows without touching the earlier
-- batch (Rule A — nothing destroyed, full audit history stays). Two rows
-- then match retire_offer's per-field WHERE offer_id = ... AND field_name =
-- '...' subquery, and a scalar subquery expects 0 or 1 rows — Postgres
-- raised "more than one row returned by a subquery used as an expression",
-- surfaced to the caller as a clean 500 (the atomicity working exactly as
-- intended: no partial revert happened).
--
-- Fix: every subquery in retire_offer now reads ORDER BY captured_at DESC
-- LIMIT 1 — the MOST RECENT snapshot batch for this offer_id, which is the
-- correct "prior state before THIS acceptance" regardless of how many times
-- the offer has been accepted and retired before. Older batches are left in
-- the table untouched (audit trail, never deleted).
--
-- Owner: Carter, 2026-09-21.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.retire_offer(p_offer_id UUID, p_user_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_offer RECORD;
BEGIN
  SELECT * INTO v_offer FROM public.transaction_offers
    WHERE id = p_offer_id AND user_id = p_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_offer.status IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'offer_not_accepted' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.transactions t SET
    sale_price = (SELECT prior_value::numeric FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'sale_price' ORDER BY captured_at DESC LIMIT 1),
    contract_effective_date = (SELECT prior_value::date FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'contract_effective_date' ORDER BY captured_at DESC LIMIT 1),
    closing_date = (SELECT prior_value::date FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'closing_date' ORDER BY captured_at DESC LIMIT 1),
    earnest_money = (SELECT prior_value::numeric FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'earnest_money' ORDER BY captured_at DESC LIMIT 1),
    option_fee = (SELECT prior_value::numeric FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'option_fee' ORDER BY captured_at DESC LIMIT 1),
    option_days = (SELECT prior_value::integer FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'option_days' ORDER BY captured_at DESC LIMIT 1),
    option_fee_due_date = (SELECT prior_value::date FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'option_fee_due_date' ORDER BY captured_at DESC LIMIT 1),
    earnest_money_due_date = (SELECT prior_value::date FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'earnest_money_due_date' ORDER BY captured_at DESC LIMIT 1),
    option_expiration_date = (SELECT prior_value::date FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'option_expiration_date' ORDER BY captured_at DESC LIMIT 1),
    option_fee_amount = (SELECT prior_value::numeric FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'option_fee_amount' ORDER BY captured_at DESC LIMIT 1),
    option_fee_paid_at = (SELECT prior_value::timestamptz FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'option_fee_paid_at' ORDER BY captured_at DESC LIMIT 1),
    option_fee_paid_to = (SELECT prior_value FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'option_fee_paid_to' ORDER BY captured_at DESC LIMIT 1),
    option_fee_confirmed_at = (SELECT prior_value::timestamptz FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'option_fee_confirmed_at' ORDER BY captured_at DESC LIMIT 1),
    earnest_money_amount = (SELECT prior_value::numeric FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'earnest_money_amount' ORDER BY captured_at DESC LIMIT 1),
    earnest_money_deposited_at = (SELECT prior_value::timestamptz FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'earnest_money_deposited_at' ORDER BY captured_at DESC LIMIT 1),
    earnest_money_confirmed_at = (SELECT prior_value::timestamptz FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'earnest_money_confirmed_at' ORDER BY captured_at DESC LIMIT 1),
    earnest_money_title_company = (SELECT prior_value FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'earnest_money_title_company' ORDER BY captured_at DESC LIMIT 1)
  WHERE t.id = v_offer.transaction_id;

  UPDATE public.transaction_offers SET
    status = 'retired',
    retired_at = NOW(),
    retired_reason = p_reason
  WHERE id = p_offer_id;

  RETURN jsonb_build_object('ok', true, 'offer_id', p_offer_id, 'transaction_id', v_offer.transaction_id);
END;
$fn$;

COMMENT ON FUNCTION public.retire_offer(UUID, UUID, TEXT) IS
  'Atomically reverts an accepted offer''s 17 SNAPSHOT_FIELDS back to their pre-acceptance values (using the MOST RECENT snapshot batch for this offer_id, so a re-accepted-after-retirement offer still reverts correctly) and flips the offer to retired. Nothing is deleted.';
