// Vercel Serverless Function: /api/create-checkout-session
// Creates a Stripe Checkout Session for the Dossie Founding Member subscription.
// POST { email? } -> { ok: true, url }
//
// Environment:
//   STRIPE_SECRET_KEY  — Stripe secret API key (LIVE mode in production)
//
// Hard-coded price: price_1TPxxNL920SKTEEiN7Gphq8T (Founding Member, $29/mo).

const Stripe = require('stripe');
const {
  validateEmail,
  sanitizeString,
  ValidationError,
} = require('./_middleware/validate');
const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');

const FOUNDING_PRICE_ID = 'price_1TPxxNL920SKTEEiN7Gphq8T';
const SUCCESS_URL = 'https://meetdossie.com/welcome.html?session_id={CHECKOUT_SESSION_ID}';
const CANCEL_URL = 'https://meetdossie.com/founding.html';

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin)) {
      allowOrigin = origin;
    }
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  return Boolean(allowOrigin);
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
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'create-checkout-session', 20, 60 * 60 * 1000);

    const body = req.body || {};
    let customerEmail = null;
    if (body.email !== undefined && body.email !== null && body.email !== '') {
      const cleaned = sanitizeString(body.email, { maxLength: 320 });
      const lower = cleaned ? cleaned.toLowerCase() : null;
      if (!lower || !validateEmail(lower)) {
        throw new ValidationError('That email looks off. Mind double-checking it?');
      }
      customerEmail = lower;
    }

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });

    const sessionParams = {
      mode: 'subscription',
      line_items: [{ price: FOUNDING_PRICE_ID, quantity: 1 }],
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      metadata: { source: 'founding_landing' },
      subscription_data: { metadata: { source: 'founding_landing' } },
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
    if (err instanceof ValidationError) {
      res.status(err.status || 400).json({ ok: false, error: err.message });
      return;
    }
    if (err instanceof RateLimitError) {
      if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
      res.status(429).json({ ok: false, error: 'Too many checkout attempts. Try again in a few minutes.' });
      return;
    }

    console.error('[create-checkout-session] Stripe error:', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: 'Could not start checkout. Try again in a moment.' });
  }
};
