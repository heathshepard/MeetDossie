-- ============================================================================
-- Offers model, the atomic accept/retire step (item 2, third commit).
--
-- Coordinator: "The revert step, atomic in one transaction — snapshot
-- lookup, write flat columns, flip status. A partial revert leaves a deal
-- half-reverted with live deadlines, which is the worst possible state."
--
-- A single Postgres function call is one implicit transaction — any
-- exception inside rolls back everything the function already did. That's
-- the simplest correct way to get atomicity here (PostgREST can't wrap
-- multiple separate REST calls in one transaction), so both halves of this
-- mechanism are plpgsql functions, called via PostgREST RPC
-- (rpc/accept_offer, rpc/retire_offer) with the service-role key. p_user_id
-- is always supplied BY THE SERVER from verifySupabaseToken(req) — never
-- from client input — matching the 2026-09-17 impersonation-bug rule
-- (identity from the verified session, never a parameter).
--
-- accept_offer: snapshots all 17 SNAPSHOT_FIELDS (api/_lib/offer-field-
-- snapshots.js) as of right now, writes the ~5 offer-derived fields onto
-- transactions, flips the offer to accepted. The other 12 fields get a
-- no-op snapshot row (new_value = prior_value) purely so a LATER revert has
-- a correct pre-offer value for whatever gets written under this offer's
-- lifecycle after acceptance (funds confirmations, deposits) — see that
-- file's header comment for the full reasoning.
--
-- retire_offer: reads this offer's OWN snapshot rows (never another
-- offer's — no chain-walking, see offer-field-snapshots.js) and writes
-- every one of the 17 columns back in ONE UPDATE statement, so the
-- funds-due-date trigger's precedence rule (trg_transactions_funds_due_dates)
-- treats every value as caller-supplied instead of recomputing a subset.
-- Then flips the offer to retired. Nothing is deleted (Rule A).
--
-- Idempotency: accept_offer refuses to run twice on the same offer
-- (offer_already_accepted) — a second accept would snapshot the ALREADY-
-- REVERTED-FROM-A state as if it were pristine pre-offer, corrupting the
-- chain. retire_offer refuses on a non-accepted offer (offer_not_accepted).
--
-- CORRECTION (same day, live testing): retire_offer as originally written
-- below breaks if an offer is accepted, retired, then re-accepted later (a
-- real sequence — accept_offer's idempotency guard only blocks re-running on
-- a CURRENTLY 'accepted' offer, not a retired one). The second accept inserts
-- a second batch of 17 snapshot rows, and retire_offer's bare per-field
-- subqueries then match 2 rows instead of 0-1 and error. See
-- supabase/migrations/20260921_retire_offer_latest_batch_only.sql for the
-- fix (ORDER BY captured_at DESC LIMIT 1 on every subquery) — that migration
-- supersedes the retire_offer definition below; this file is left as the
-- original historical record.
--
-- Owner: Carter, 2026-09-21.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.accept_offer(p_offer_id UUID, p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_offer RECORD;
  v_tx RECORD;
BEGIN
  SELECT * INTO v_offer FROM public.transaction_offers
    WHERE id = p_offer_id AND user_id = p_user_id AND archived_at IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_offer.status = 'accepted' THEN
    RAISE EXCEPTION 'offer_already_accepted' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_tx FROM public.transactions
    WHERE id = v_offer.transaction_id AND user_id = p_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transaction_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- All 17 fields, snapshotted now. Offer-mapped fields get new_value from
  -- the offer; everything else is a no-op row (new_value = prior_value).
  INSERT INTO public.offer_field_snapshots (offer_id, transaction_id, user_id, field_name, prior_value, new_value)
  VALUES
    (p_offer_id, v_tx.id, p_user_id, 'sale_price', v_tx.sale_price::text, COALESCE(v_offer.offer_price::text, v_tx.sale_price::text)),
    (p_offer_id, v_tx.id, p_user_id, 'contract_effective_date', v_tx.contract_effective_date::text, v_tx.contract_effective_date::text),
    (p_offer_id, v_tx.id, p_user_id, 'closing_date', v_tx.closing_date::text, COALESCE(v_offer.closing_date::text, v_tx.closing_date::text)),
    (p_offer_id, v_tx.id, p_user_id, 'earnest_money', v_tx.earnest_money::text, COALESCE(v_offer.earnest_money::text, v_tx.earnest_money::text)),
    (p_offer_id, v_tx.id, p_user_id, 'option_fee', v_tx.option_fee::text, COALESCE(v_offer.option_fee::text, v_tx.option_fee::text)),
    (p_offer_id, v_tx.id, p_user_id, 'option_days', v_tx.option_days::text, COALESCE(v_offer.option_days::text, v_tx.option_days::text)),
    (p_offer_id, v_tx.id, p_user_id, 'option_fee_due_date', v_tx.option_fee_due_date::text, v_tx.option_fee_due_date::text),
    (p_offer_id, v_tx.id, p_user_id, 'earnest_money_due_date', v_tx.earnest_money_due_date::text, v_tx.earnest_money_due_date::text),
    (p_offer_id, v_tx.id, p_user_id, 'option_expiration_date', v_tx.option_expiration_date::text, v_tx.option_expiration_date::text),
    (p_offer_id, v_tx.id, p_user_id, 'option_fee_amount', v_tx.option_fee_amount::text, v_tx.option_fee_amount::text),
    (p_offer_id, v_tx.id, p_user_id, 'option_fee_paid_at', v_tx.option_fee_paid_at::text, v_tx.option_fee_paid_at::text),
    (p_offer_id, v_tx.id, p_user_id, 'option_fee_paid_to', v_tx.option_fee_paid_to, v_tx.option_fee_paid_to),
    (p_offer_id, v_tx.id, p_user_id, 'option_fee_confirmed_at', v_tx.option_fee_confirmed_at::text, v_tx.option_fee_confirmed_at::text),
    (p_offer_id, v_tx.id, p_user_id, 'earnest_money_amount', v_tx.earnest_money_amount::text, v_tx.earnest_money_amount::text),
    (p_offer_id, v_tx.id, p_user_id, 'earnest_money_deposited_at', v_tx.earnest_money_deposited_at::text, v_tx.earnest_money_deposited_at::text),
    (p_offer_id, v_tx.id, p_user_id, 'earnest_money_confirmed_at', v_tx.earnest_money_confirmed_at::text, v_tx.earnest_money_confirmed_at::text),
    (p_offer_id, v_tx.id, p_user_id, 'earnest_money_title_company', v_tx.earnest_money_title_company, v_tx.earnest_money_title_company);

  UPDATE public.transactions SET
    sale_price = COALESCE(v_offer.offer_price, sale_price),
    closing_date = COALESCE(v_offer.closing_date, closing_date),
    earnest_money = COALESCE(v_offer.earnest_money, earnest_money),
    option_fee = COALESCE(v_offer.option_fee, option_fee),
    option_days = COALESCE(v_offer.option_days, option_days)
  WHERE id = v_tx.id;

  UPDATE public.transaction_offers SET
    status = 'accepted',
    accepted_at = NOW(),
    applied_to_transaction_at = NOW()
  WHERE id = p_offer_id;

  RETURN jsonb_build_object('ok', true, 'offer_id', p_offer_id, 'transaction_id', v_tx.id);
END;
$fn$;

COMMENT ON FUNCTION public.accept_offer(UUID, UUID) IS
  'Atomically snapshots all 17 SNAPSHOT_FIELDS and applies an offer''s terms onto its transaction. See api/_lib/offer-field-snapshots.js for the field list and api/transaction-offers.js for the caller.';

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

  -- One UPDATE statement, all 17 columns, so the funds-due-date trigger
  -- treats every value as caller-supplied (see module header + the trigger's
  -- own precedence comment in funds-due-dates-trigger-sql.js).
  UPDATE public.transactions t SET
    sale_price = (SELECT prior_value::numeric FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'sale_price'),
    contract_effective_date = (SELECT prior_value::date FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'contract_effective_date'),
    closing_date = (SELECT prior_value::date FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'closing_date'),
    earnest_money = (SELECT prior_value::numeric FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'earnest_money'),
    option_fee = (SELECT prior_value::numeric FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'option_fee'),
    option_days = (SELECT prior_value::integer FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'option_days'),
    option_fee_due_date = (SELECT prior_value::date FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'option_fee_due_date'),
    earnest_money_due_date = (SELECT prior_value::date FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'earnest_money_due_date'),
    option_expiration_date = (SELECT prior_value::date FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'option_expiration_date'),
    option_fee_amount = (SELECT prior_value::numeric FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'option_fee_amount'),
    option_fee_paid_at = (SELECT prior_value::timestamptz FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'option_fee_paid_at'),
    option_fee_paid_to = (SELECT prior_value FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'option_fee_paid_to'),
    option_fee_confirmed_at = (SELECT prior_value::timestamptz FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'option_fee_confirmed_at'),
    earnest_money_amount = (SELECT prior_value::numeric FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'earnest_money_amount'),
    earnest_money_deposited_at = (SELECT prior_value::timestamptz FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'earnest_money_deposited_at'),
    earnest_money_confirmed_at = (SELECT prior_value::timestamptz FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'earnest_money_confirmed_at'),
    earnest_money_title_company = (SELECT prior_value FROM public.offer_field_snapshots WHERE offer_id = p_offer_id AND field_name = 'earnest_money_title_company')
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
  'Atomically reverts an accepted offer''s 17 SNAPSHOT_FIELDS on its transaction back to their pre-offer values and flips the offer to retired. Nothing is deleted (Rule A). Reads only this offer''s own snapshot rows — no chain-walking.';
