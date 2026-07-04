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

    if (action === 'get_balance') {
      // Live Stripe balance + last-45-day charge summary. Used by the admin
      // dashboard BILLING PULSE widget and Cole's Telegram balance check.
      // Our stripe_payment_log table only captures checkout.session.completed —
      // recurring invoice.paid events bypass it. So we hit Stripe directly.
      const balance = await stripe.balance.retrieve();

      const centsToUsd = (cents) => Number((cents / 100).toFixed(2));

      // Sum available/pending across all currencies (we only take USD today,
      // but this future-proofs and stays honest if a non-USD balance appears).
      let availableUsdCents = 0;
      let pendingUsdCents = 0;
      const availableByCurrency = {};
      const pendingByCurrency = {};
      for (const bucket of (balance.available || [])) {
        availableByCurrency[bucket.currency] = (availableByCurrency[bucket.currency] || 0) + bucket.amount;
        if (bucket.currency === 'usd') availableUsdCents += bucket.amount;
      }
      for (const bucket of (balance.pending || [])) {
        pendingByCurrency[bucket.currency] = (pendingByCurrency[bucket.currency] || 0) + bucket.amount;
        if (bucket.currency === 'usd') pendingUsdCents += bucket.amount;
      }

      // Pull recent successful charges — last 45 days covers month-2/month-3
      // renewal windows for the founding cohort.
      const nowSec = Math.floor(Date.now() / 1000);
      const fortyFiveDaysAgoSec = nowSec - (45 * 24 * 60 * 60);
      const charges = await stripe.charges.list({
        limit: 100,
        created: { gte: fortyFiveDaysAgoSec },
      });

      // Enrich charges with customer email. Prefer billing_details.email;
      // fall back to a Stripe customer lookup when it's missing (rare on
      // subscription invoices but happens on manually-created charges).
      const customerEmailCache = {};
      const recentCharges = [];
      let totalLast45DaysCents = 0;
      for (const ch of (charges.data || [])) {
        if (ch.status !== 'succeeded') continue;
        totalLast45DaysCents += ch.amount;

        let email = ch.billing_details?.email || ch.receipt_email || null;
        if (!email && ch.customer) {
          const custId = typeof ch.customer === 'string' ? ch.customer : ch.customer?.id;
          if (custId) {
            if (customerEmailCache[custId] !== undefined) {
              email = customerEmailCache[custId];
            } else {
              try {
                const cust = await stripe.customers.retrieve(custId);
                email = cust?.email || null;
                customerEmailCache[custId] = email;
              } catch (e) {
                customerEmailCache[custId] = null;
              }
            }
          }
        }

        recentCharges.push({
          id: ch.id,
          amount_usd: centsToUsd(ch.amount),
          currency: ch.currency,
          created_iso: new Date(ch.created * 1000).toISOString(),
          description: ch.description || ch.statement_descriptor || null,
          customer_email: email,
          invoice: ch.invoice || null,
        });
      }

      // Sort newest-first (charges.list already returns this way but we're
      // being explicit since we filtered in-place).
      recentCharges.sort((a, b) => (a.created_iso < b.created_iso ? 1 : -1));

      return res.status(200).json({
        ok: true,
        available_usd: centsToUsd(availableUsdCents),
        pending_usd: centsToUsd(pendingUsdCents),
        available_by_currency: Object.fromEntries(
          Object.entries(availableByCurrency).map(([c, amt]) => [c, centsToUsd(amt)])
        ),
        pending_by_currency: Object.fromEntries(
          Object.entries(pendingByCurrency).map(([c, amt]) => [c, centsToUsd(amt)])
        ),
        recent_charges: recentCharges.slice(0, 25),
        recent_charges_count_total: recentCharges.length,
        total_last_45d_usd: centsToUsd(totalLast45DaysCents),
        as_of_iso: new Date().toISOString(),
      });
    }

    if (action === 'list_customer_subs') {
      // Read-only: list ALL subscriptions on a customer (any status).
      // Used for reconciliation when a customer's active-in-Stripe sub ID
      // differs from the one we have in our DB. NO WRITES.
      const customerId = req.query?.customer_id || (req.body && req.body.customer_id);
      if (!customerId) return res.status(400).json({ ok: false, error: 'customer_id required' });
      const subs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 20,
      });
      return res.status(200).json({
        ok: true,
        customer: customerId,
        subscriptions: (subs.data || []).map((s) => ({
          id: s.id,
          status: s.status,
          created_iso: new Date(s.created * 1000).toISOString(),
          current_period_end_iso: s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : null,
          cancel_at_period_end: s.cancel_at_period_end,
          canceled_at_iso: s.canceled_at ? new Date(s.canceled_at * 1000).toISOString() : null,
          ended_at_iso: s.ended_at ? new Date(s.ended_at * 1000).toISOString() : null,
          price_id: s?.items?.data?.[0]?.price?.id || null,
        })),
      });
    }

    return res.status(400).json({ ok: false, error: 'unknown action; use get_price | create_coupon | get_coupon | get_subscription | get_balance | list_customer_subs' });
  } catch (err) {
    return res.status(502).json({ ok: false, error: (err && err.message) || String(err) });
  }
};
