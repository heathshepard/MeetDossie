// Vercel Serverless Function: /api/get-checkout-session
// Retrieves Stripe checkout session details to pre-fill onboarding form
// GET ?session_id={CHECKOUT_SESSION_ID} -> { ok: true, email, name? }
//
// Environment:
//   STRIPE_SECRET_KEY — Stripe secret API key

const Stripe = require('stripe');

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
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error('[get-checkout-session] STRIPE_SECRET_KEY is not set.');
    res.status(500).json({ ok: false, error: 'Stripe is not configured.' });
    return;
  }

  const sessionId = (req.query && req.query.session_id) || '';
  if (!sessionId || typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
    res.status(400).json({ ok: false, error: 'Invalid session_id.' });
    return;
  }

  try {
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!session) {
      res.status(404).json({ ok: false, error: 'Session not found.' });
      return;
    }

    const email = (session.customer_details && session.customer_details.email)
      || session.customer_email
      || null;
    const name = (session.customer_details && session.customer_details.name) || null;

    res.status(200).json({
      ok: true,
      email: email ? String(email).toLowerCase() : null,
      name: name ? String(name) : null,
    });
  } catch (err) {
    console.error('[get-checkout-session] Stripe error:', err && err.message);
    res.status(500).json({ ok: false, error: 'Could not retrieve session details.' });
  }
};
