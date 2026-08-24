// Vercel Serverless Function: /api/admin-stripe-tools
// Tiny operations endpoint for inspecting and configuring our Stripe account.
//   GET  ?action=get_price&price_id=<id> → unit_amount/currency/recurring
//   POST { action: "create_price", product_name, unit_amount, currency?, interval, nickname? }
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

    if (action === 'create_price') {
      // Creates a Product + Price together — used once per new sellable
      // thing (e.g. the Email Integration add-on, 2026-08-22). Idempotent by
      // product name: if a product with this exact name already exists and
      // is active, reuses it instead of creating a duplicate.
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      body = body || {};
      const { product_name, unit_amount, currency, interval, nickname } = body;
      if (!product_name || unit_amount == null || !interval) {
        return res.status(400).json({ ok: false, error: 'product_name, unit_amount, interval required' });
      }
      const existingProducts = await stripe.products.search({ query: `name:"${product_name}" AND active:"true"` }).catch(() => ({ data: [] }));
      let product = (existingProducts.data || [])[0];
      if (!product) {
        product = await stripe.products.create({ name: product_name });
      }
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: Number(unit_amount),
        currency: currency || 'usd',
        recurring: { interval },
        nickname: nickname || undefined,
      });
      return res.status(200).json({ ok: true, product: { id: product.id, name: product.name }, price: { id: price.id, unit_amount: price.unit_amount, currency: price.currency, recurring: price.recurring } });
    }

    if (action === 'deactivate_price') {
      // Archives a mis-created Price object (active:false) so it can never be
      // selected by a checkout session again. Does not delete — Stripe prices
      // are immutable/permanent once used, this just retires it.
      const priceId = req.query?.price_id || (req.body && req.body.price_id);
      if (!priceId) return res.status(400).json({ ok: false, error: 'price_id required' });
      const price = await stripe.prices.update(priceId, { active: false });
      return res.status(200).json({ ok: true, price: { id: price.id, active: price.active } });
    }

    if (action === 'get_coupon') {
      const couponId = req.query?.id || (req.body && req.body.id);
      if (!couponId) return res.status(400).json({ ok: false, error: 'id required' });
      const coupon = await stripe.coupons.retrieve(couponId);
      return res.status(200).json({ ok: true, coupon });
    }

    if (action === 'get_checkout_session') {
      // Read-only. Inspects a real (but not-yet-completed) Checkout Session
      // for its actual line items / discount / total — used to verify a
      // real create-*-checkout-session.js endpoint built the session
      // correctly (e.g. the founding 50%-off coupon actually applied)
      // without ever completing the payment. Added 2026-08-24 for the
      // Compliance Vault add-on verification pass.
      const sessionId = req.query?.session_id || (req.body && req.body.session_id);
      if (!sessionId) return res.status(400).json({ ok: false, error: 'session_id required' });
      const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items', 'total_details.breakdown'] });
      return res.status(200).json({
        ok: true,
        session: {
          id: session.id,
          status: session.status,
          amount_subtotal: session.amount_subtotal,
          amount_total: session.amount_total,
          currency: session.currency,
          customer: session.customer,
          customer_email: session.customer_email,
          client_reference_id: session.client_reference_id,
          metadata: session.metadata,
          total_details: session.total_details,
          line_items: (session.line_items && session.line_items.data ? session.line_items.data : []).map((li) => ({
            description: li.description,
            price_id: li.price && li.price.id,
            amount_subtotal: li.amount_subtotal,
            amount_total: li.amount_total,
            quantity: li.quantity,
          })),
        },
      });
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

    if (action === 'search_products') {
      // Read-only. Lists products whose name contains the given substring
      // (case-insensitive), each with its active prices. Used to discover
      // the real Team/Solo product+price IDs without ever having the raw
      // Stripe secret key available outside this deployed function — every
      // env var that carries a live price ID is Vercel-Sensitive/write-only
      // per CLAUDE.md Section 19, so this is the only way to look one up.
      const q = ((req.query?.q || (req.body && req.body.q)) || '').toLowerCase();
      const products = await stripe.products.list({ active: true, limit: 100 });
      const matches = (products.data || []).filter((p) => !q || p.name.toLowerCase().includes(q));
      const withPrices = [];
      for (const p of matches) {
        const prices = await stripe.prices.list({ product: p.id, active: true, limit: 20 });
        withPrices.push({
          product_id: p.id,
          product_name: p.name,
          prices: (prices.data || []).map((pr) => ({
            id: pr.id,
            unit_amount: pr.unit_amount,
            currency: pr.currency,
            recurring: pr.recurring,
            nickname: pr.nickname,
          })),
        });
      }
      return res.status(200).json({ ok: true, products: withPrices });
    }

    if (action === 'preview_invoice') {
      // Read-only / non-committal. Uses stripe.invoices.createPreview (the
      // stripe npm v22 replacement for the deprecated retrieveUpcoming) to
      // show exactly what a subscription with the given line items WOULD
      // cost, without creating or modifying any real subscription.
      //
      // Two modes:
      //   - { items: [{price, quantity}] } with no customer/subscription:
      //     creates a throwaway Customer (no payment method — cannot ever be
      //     charged), previews a hypothetical NEW subscription with those
      //     items, then deletes the throwaway customer before responding.
      //   - { subscription_id, items: [{price, quantity}] }: previews what
      //     changing an EXISTING real subscription's items to the given set
      //     would cost (proration included) — still does not commit the
      //     change, stripe.subscriptions.update is never called here.
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      body = body || {};
      const items = Array.isArray(body.items) ? body.items : null;
      if (!items || items.length === 0) {
        return res.status(400).json({ ok: false, error: 'items[] required, e.g. [{"price":"price_...","quantity":1}]' });
      }

      let throwawayCustomerId = null;
      try {
        let previewParams;
        if (body.subscription_id) {
          previewParams = {
            subscription: body.subscription_id,
            subscription_details: { items },
          };
        } else {
          const customer = await stripe.customers.create({
            email: 'carter-billing-preview@example.com',
            name: 'CARTER PREVIEW — safe to delete, no payment method attached',
            metadata: { purpose: 'invoice_preview_throwaway', created_by: 'admin-stripe-tools' },
          });
          throwawayCustomerId = customer.id;
          previewParams = {
            customer: throwawayCustomerId,
            subscription_details: { items },
          };
        }

        const preview = await stripe.invoices.createPreview(previewParams);
        const lines = (preview.lines && preview.lines.data ? preview.lines.data : []).map((l) => ({
          description: l.description,
          amount: l.amount,
          currency: l.currency,
          price_id: l.pricing?.price_details?.price || l.price?.id || null,
          quantity: l.quantity,
        }));

        return res.status(200).json({
          ok: true,
          used_throwaway_customer: Boolean(throwawayCustomerId),
          total: preview.total,
          subtotal: preview.subtotal,
          currency: preview.currency,
          lines,
        });
      } finally {
        if (throwawayCustomerId) {
          await stripe.customers.del(throwawayCustomerId).catch((e) => {
            console.warn('[admin-stripe-tools] failed to delete throwaway preview customer', throwawayCustomerId, e.message);
          });
        }
      }
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

    return res.status(400).json({ ok: false, error: 'unknown action; use get_price | create_price | deactivate_price | create_coupon | get_coupon | get_subscription | get_checkout_session | get_balance | list_customer_subs | search_products | preview_invoice' });
  } catch (err) {
    return res.status(502).json({ ok: false, error: (err && err.message) || String(err) });
  }
};
