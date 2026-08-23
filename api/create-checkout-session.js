// Vercel Serverless Function: /api/create-checkout-session
// Creates a real Stripe Checkout Session for a Solo or Team subscription.
// POST { plan: 'solo'|'team', billing_period?: 'monthly'|'annual', email? }
//   -> { ok: true, url }
//
// REOPENED 2026-08-22. This endpoint returned a hardcoded 410 from
// 2026-08-13 to 2026-08-22 — Solo/Team had no live Stripe price IDs, so
// there was nothing valid to sell (see docs/GOLD-HISTORY.md, commit
// b08d414c). The 4 real prices (Solo/Team x monthly/annual) were created
// 2026-08-22 via /api/admin-stripe-tools and live in Vercel env — see
// api/_lib/pricing-tiers.js.
//
// Founding ($29/mo) stays permanently closed — this endpoint never sells it.
// Pattern follows the original founding checkout (commit 12d221b3): same
// CORS + rate-limit posture, same subscription-mode Checkout Session shape.
//
// Environment:
//   STRIPE_SECRET_KEY — Stripe secret API key (live mode in production)
//   STRIPE_PRICE_SOLO_MONTHLY / STRIPE_PRICE_SOLO_ANNUAL
//   STRIPE_PRICE_TEAM_MONTHLY / STRIPE_PRICE_TEAM_ANNUAL

const Stripe = require('stripe');
const { applyCorsHeaders } = require('./_middleware/cors');
const { checkRateLimit, RateLimitError, clientIpFromReq } = require('./_middleware/rateLimit');
const { CHECKOUT_PRICE_IDS } = require('./_lib/pricing-tiers');

const SUCCESS_URL = 'https://meetdossie.com/welcome.html?session_id={CHECKOUT_SESSION_ID}';
const CANCEL_URL = 'https://meetdossie.com/signup.html';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_PLANS = new Set(['solo', 'team']);
const VALID_PERIODS = new Set(['monthly', 'annual']);

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'POST, OPTIONS', headers: 'Content-Type' });
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(corsAllowed ? 204 : 403).end();
    return;
  }

  if (!corsAllowed) {
    res.status(403).json({ ok: false, error: 'Origin not allowed.' });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error('[create-checkout-session] STRIPE_SECRET_KEY is not set.');
    res.status(500).json({ ok: false, error: 'Checkout is temporarily unavailable.' });
    return;
  }

  try {
    await checkRateLimit(clientIpFromReq(req), 'create-checkout-session', 20, 60 * 60 * 1000);

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};

    const plan = String(body.plan || '').trim().toLowerCase();
    const billingPeriod = String(body.billing_period || 'monthly').trim().toLowerCase();

    if (!VALID_PLANS.has(plan)) {
      res.status(400).json({ ok: false, error: "plan must be 'solo' or 'team'.", field: 'plan' });
      return;
    }
    if (!VALID_PERIODS.has(billingPeriod)) {
      res.status(400).json({ ok: false, error: "billing_period must be 'monthly' or 'annual'.", field: 'billing_period' });
      return;
    }

    const priceId = CHECKOUT_PRICE_IDS[plan][billingPeriod];
    if (!priceId) {
      console.error('[create-checkout-session] no price ID configured for', plan, billingPeriod);
      res.status(500).json({ ok: false, error: 'That plan is not available for checkout right now. Email heath@meetdossie.com.' });
      return;
    }

    let customerEmail = null;
    if (body.email) {
      const cleaned = String(body.email).trim().toLowerCase();
      if (!EMAIL_RE.test(cleaned)) {
        res.status(400).json({ ok: false, error: 'That email looks off. Mind double-checking it?', field: 'email' });
        return;
      }
      customerEmail = cleaned;
    }

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });

    const sessionMetadata = { source: 'signup_page', plan, billing_period: billingPeriod };
    const sessionParams = {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      metadata: sessionMetadata,
      subscription_data: { metadata: sessionMetadata },
    };
    if (customerEmail) {
      sessionParams.customer_email = customerEmail;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    if (!session || !session.url) {
      console.error('[create-checkout-session] Stripe returned no session url.');
      res.status(502).json({ ok: false, error: 'Could not start checkout. Try again in a moment.' });
      return;
    }

    res.status(200).json({ ok: true, url: session.url });
  } catch (err) {
    if (err instanceof RateLimitError) {
      if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
      res.status(429).json({ ok: false, error: 'Too many checkout attempts. Try again in a few minutes.' });
      return;
    }
    console.error('[create-checkout-session] Stripe error:', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: 'Could not start checkout. Try again in a moment.' });
  }
};
