// One-time migration: accept_offer / retire_offer Postgres functions — see
// supabase/migrations/20260921_offers_model_accept_retire_functions.sql for
// full commentary. Safe to re-run (CREATE OR REPLACE FUNCTION throughout).
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-21 (offers model, item 2 — atomic accept/retire).

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
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
  'Atomically snapshots all 17 SNAPSHOT_FIELDS and applies an offer''s terms onto its transaction. See api/_lib/offer-field-snapshots.js.';

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
  'Atomically reverts an accepted offer''s 17 SNAPSHOT_FIELDS back to pre-offer values and flips the offer to retired. Nothing is deleted. Reads only this offer''s own snapshot rows.';
`;

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(SQL);
    return res.status(200).json({
      ok: true,
      message: 'accept_offer + retire_offer functions installed successfully',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to install accept_offer/retire_offer',
      details: err.message,
    });
  }
};
