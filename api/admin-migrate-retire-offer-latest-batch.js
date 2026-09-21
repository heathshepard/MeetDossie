// One-time fix: retire_offer broke on a re-accepted (previously retired)
// offer — see supabase/migrations/20260921_retire_offer_latest_batch_only.sql
// for the full story (found live testing the accept -> retire ->
// accept-a-backup chain).
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-21.

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
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
  'Atomically reverts an accepted offer''s 17 SNAPSHOT_FIELDS back to their pre-acceptance values (using the MOST RECENT snapshot batch for this offer_id). Nothing is deleted.';
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
    return res.status(200).json({ ok: true, message: 'retire_offer now uses the latest snapshot batch per field' });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to update retire_offer',
      details: err.message,
    });
  }
};
