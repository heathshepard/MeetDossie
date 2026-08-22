// Vercel Serverless Function: /api/cancel-addon-subscription
//
// Self-serve cancel-at-period-end (and undo) for the "Email Integration"
// add-on subscription created by api/create-addon-checkout-session.js.
// Deliberately schedules the cancellation for end of billing period —
// NEVER an immediate stripe.subscriptions.cancel() — the customer already
// paid for the current period and keeps access through it. When the period
// actually ends, Stripe fires customer.subscription.deleted and
// api/stripe-webhook.js's handleAddonSubscriptionDeleted unsets
// subscriptions.email_integration_enabled — this route does not touch that
// flag directly.
//
// POST (Authorization: Bearer <supabase user JWT>)
//   body: { cancelAtPeriodEnd?: boolean }  — defaults to true (schedule
//         cancellation). Pass false to undo a previously-scheduled
//         cancellation before the period ends (Stripe supports flipping
//         cancel_at_period_end back off right up until it actually fires).
//   -> { ok: true, cancelAtPeriodEnd: bool, currentPeriodEnd: ISO string|null,
//        status: "active" | ... }
//
// Looks up the subscription id from subscriptions.email_integration_stripe_sub_id
// — the same column create-addon-checkout-session.js's webhook counterpart
// (handleAddonCheckoutCompleted in api/stripe-webhook.js) writes. No new
// storage location.
//
// Environment:
//   STRIPE_SECRET_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Owner: Carter, 2026-08-22 (SV-ENG-EMAIL-INTEGRATION-ADDON)

const Stripe = require('stripe');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'POST, OPTIONS', headers: 'Content-Type, Authorization' });
}

async function supabaseFetch(path, init = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ ok: false, error: 'Origin not allowed.' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  if (!STRIPE_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Server not configured.' });
  }

  let userId;
  try {
    const auth = await verifySupabaseToken(req);
    userId = auth.userId;
  } catch (err) {
    const status = err instanceof AuthError && err.status ? err.status : 401;
    return res.status(status).json({ ok: false, error: 'Unauthorized' });
  }

  // Default true (schedule cancel). Explicit false undoes a scheduled cancel.
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const cancelAtPeriodEnd = body.cancelAtPeriodEnd !== false;

  const { ok, data } = await supabaseFetch(
    `subscriptions?select=email_integration_enabled,email_integration_stripe_sub_id&user_id=eq.${encodeURIComponent(userId)}&order=updated_at.desc&limit=1`,
  );
  const sub = ok && Array.isArray(data) ? data[0] : null;
  const stripeSubId = sub && sub.email_integration_stripe_sub_id;

  if (!sub || !sub.email_integration_enabled || !stripeSubId) {
    return res.status(400).json({ ok: false, error: 'No active Email Integration subscription found.' });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

  try {
    const updated = await stripe.subscriptions.update(stripeSubId, { cancel_at_period_end: cancelAtPeriodEnd });
    return res.status(200).json({
      ok: true,
      cancelAtPeriodEnd: !!updated.cancel_at_period_end,
      currentPeriodEnd: updated.current_period_end ? new Date(updated.current_period_end * 1000).toISOString() : null,
      status: updated.status,
    });
  } catch (err) {
    console.error('[cancel-addon-subscription] stripe error', err && err.message);
    return res.status(502).json({ ok: false, error: 'Could not update subscription.' });
  }
};
