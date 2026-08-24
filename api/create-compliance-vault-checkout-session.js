// Vercel Serverless Function: /api/create-compliance-vault-checkout-session
//
// Self-serve Stripe Checkout for the "Compliance Vault" add-on ONLY ($15/mo,
// $7.50/mo for active founding members — exactly 50% off per Terms of
// Service §4.2). Byte-for-byte the same pattern as
// api/create-addon-checkout-session.js (Email Integration) — deliberately a
// SEPARATE file per add-on rather than parameterizing one shared endpoint:
// create-addon-checkout-session.js is hardcoded to Email Integration today
// (confirmed via read, not assumed) and is a live, already-verified payment
// path — safer to add a new small file than to risk regressing it with a
// generalization refactor for a second add-on.
//
// POST (Authorization: Bearer <supabase user JWT>)
//   -> { ok: true, url: "https://checkout.stripe.com/..." }
//
// The founding 50%-off is applied server-side based on the caller's own
// subscriptions.plan==='founding' (never trusts a client-supplied discount
// flag) — reuses the SAME STRIPE_FOUNDING_ADDON_COUPON_ID as Email
// Integration (confirmed generic: a plain percent_off:50/forever coupon,
// not tied to any specific Stripe price — applies to whatever line item
// it's attached to at Checkout).
//
// On checkout.session.completed, api/stripe-webhook.js sets
// subscriptions.compliance_vault_enabled = true for this user (matched via
// client_reference_id) and records compliance_vault_stripe_sub_id.
//
// Environment:
//   STRIPE_SECRET_KEY
//   ADDON_COMPLIANCE_VAULT_PRICE_ID   — Stripe price id ($15/mo)
//   STRIPE_FOUNDING_ADDON_COUPON_ID   — optional; when set AND caller is an
//                                         active founding member, applied at
//                                         checkout for the 50% discount
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Owner: Carter, 2026-08-24 (Compliance Vault add-on for Solo)

const Stripe = require('stripe');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const ADDON_COMPLIANCE_VAULT_PRICE_ID = process.env.ADDON_COMPLIANCE_VAULT_PRICE_ID;
const STRIPE_FOUNDING_ADDON_COUPON_ID = process.env.STRIPE_FOUNDING_ADDON_COUPON_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SUCCESS_URL = 'https://meetdossie.com/app?addon=compliance-vault&status=success';
const CANCEL_URL = 'https://meetdossie.com/app?addon=compliance-vault&status=cancelled';

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
  if (!ADDON_COMPLIANCE_VAULT_PRICE_ID) {
    return res.status(503).json({ ok: false, error: 'Compliance Vault add-on is not yet purchasable — price not configured.' });
  }

  let userId, email;
  try {
    const auth = await verifySupabaseToken(req);
    userId = auth.userId;
    email = auth.email;
  } catch (err) {
    const status = err instanceof AuthError && err.status ? err.status : 401;
    return res.status(status).json({ ok: false, error: 'Unauthorized' });
  }

  const { ok, data } = await supabaseFetch(
    `subscriptions?select=plan,status,stripe_customer_id,compliance_vault_enabled&user_id=eq.${encodeURIComponent(userId)}&order=updated_at.desc&limit=1`,
  );
  const sub = ok && Array.isArray(data) ? data[0] : null;
  if (!sub) {
    return res.status(400).json({ ok: false, error: 'No active Dossie subscription found — the add-on requires a base plan first.' });
  }
  if (sub.compliance_vault_enabled) {
    return res.status(400).json({ ok: false, error: 'Compliance Vault is already active on your account.' });
  }

  const isActiveFounding = sub.plan === 'founding' && ['active', 'internal', 'pending_onboarding'].includes(sub.status);

  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

  const sessionParams = {
    mode: 'subscription',
    line_items: [{ price: ADDON_COMPLIANCE_VAULT_PRICE_ID, quantity: 1 }],
    success_url: SUCCESS_URL,
    cancel_url: CANCEL_URL,
    client_reference_id: userId,
    metadata: { addon: 'compliance_vault', user_id: userId },
    subscription_data: { metadata: { addon: 'compliance_vault', user_id: userId } },
  };

  if (sub.stripe_customer_id) {
    sessionParams.customer = sub.stripe_customer_id;
  } else if (email) {
    sessionParams.customer_email = email;
  }

  // Founding 50% off — server-decided, never trusts the client. Exactly 50%,
  // per Terms of Service §4.2 (never a different split).
  if (isActiveFounding && STRIPE_FOUNDING_ADDON_COUPON_ID) {
    sessionParams.discounts = [{ coupon: STRIPE_FOUNDING_ADDON_COUPON_ID }];
  } else {
    sessionParams.allow_promotion_codes = false;
  }

  try {
    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.status(200).json({ ok: true, url: session.url });
  } catch (err) {
    console.error('[create-compliance-vault-checkout-session] stripe error', err && err.message);
    return res.status(502).json({ ok: false, error: 'Could not start checkout.' });
  }
};
