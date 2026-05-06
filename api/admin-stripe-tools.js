// Vercel Serverless Function: /api/admin-stripe-tools
// Tiny operations endpoint for inspecting and configuring our Stripe account.
// Two actions for now:
//   GET  ?action=get_price&price_id=<id> → unit_amount/currency/recurring
//   POST { action: "create_coupon", id, percent_off?, amount_off?, currency?, duration }
//
// Auth: Bearer ${CRON_SECRET}. A short-lived ONE_SHOT_TOKEN is also accepted
// while we figure out the FOUNDING coupon situation; reverted in the very
// next commit.

const Stripe = require('stripe');

const CRON_SECRET = process.env.CRON_SECRET;

function isAuthed(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  return Boolean(CRON_SECRET) && h === `Bearer ${CRON_SECRET}`;
}

module.exports = async function handler(req, res) {
  if (!isAuthed(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return res.status(500).json({ ok: false, error: 'STRIPE_SECRET_KEY not configured' });
  }
  const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });

  const action = (req.query?.action || (req.body && (typeof req.body === 'string' ? JSON.parse(req.body) : req.body))?.action || '').toLowerCase();

  try {
    if (action === 'get_price') {
      const priceId = req.query?.price_id || (req.body && req.body.price_id);
      if (!priceId) return res.status(400).json({ ok: false, error: 'price_id required' });
      const price = await stripe.prices.retrieve(priceId);
      return res.status(200).json({
        ok: true,
        price: {
          id: price.id,
          unit_amount: price.unit_amount,
          unit_amount_decimal: price.unit_amount_decimal,
          currency: price.currency,
          recurring: price.recurring,
          active: price.active,
          nickname: price.nickname,
          product: price.product,
        },
      });
    }

    if (action === 'create_coupon') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      body = body || {};
      const params = { id: body.id, duration: body.duration || 'forever' };
      if (body.percent_off != null) params.percent_off = Number(body.percent_off);
      if (body.amount_off != null) params.amount_off = Number(body.amount_off);
      if (body.currency) params.currency = body.currency;
      if (body.name) params.name = body.name;
      if (!params.id) return res.status(400).json({ ok: false, error: 'id required' });
      if (params.percent_off == null && params.amount_off == null) {
        return res.status(400).json({ ok: false, error: 'percent_off or amount_off required' });
      }
      const coupon = await stripe.coupons.create(params);
      return res.status(200).json({ ok: true, coupon });
    }

    if (action === 'get_coupon') {
      const couponId = req.query?.id || (req.body && req.body.id);
      if (!couponId) return res.status(400).json({ ok: false, error: 'id required' });
      const coupon = await stripe.coupons.retrieve(couponId);
      return res.status(200).json({ ok: true, coupon });
    }

    if (action === 'get_subscription') {
      const subId = req.query?.subscription_id || (req.body && req.body.subscription_id);
      if (!subId) return res.status(400).json({ ok: false, error: 'subscription_id required' });
      const sub = await stripe.subscriptions.retrieve(subId);
      // Surface only the fields we actually consume — keeps the payload small.
      return res.status(200).json({
        ok: true,
        subscription: {
          id: sub.id,
          status: sub.status,
          customer: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
          current_period_start: sub.current_period_start,
          current_period_end: sub.current_period_end,
          cancel_at_period_end: sub.cancel_at_period_end,
          price_id: sub?.items?.data?.[0]?.price?.id || null,
          price_unit_amount: sub?.items?.data?.[0]?.price?.unit_amount,
          price_currency: sub?.items?.data?.[0]?.price?.currency,
        },
      });
    }

    return res.status(400).json({ ok: false, error: 'unknown action; use get_price | create_coupon | get_coupon | get_subscription' });
  } catch (err) {
    return res.status(502).json({ ok: false, error: (err && err.message) || String(err) });
  }
};
