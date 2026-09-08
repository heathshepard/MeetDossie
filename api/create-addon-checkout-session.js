// Vercel Serverless Function: /api/create-addon-checkout-session
//
// Self-serve Stripe Checkout for the "Email Integration" add-on ONLY
// ($15/mo, $7.50/mo for active founding members — exactly 50% off per Terms
// of Service §4.2). Deliberately scoped narrow: this does NOT touch the
// base-plan (Solo/Team) checkout question, which is a separate, much bigger
// project (see api/create-checkout-session.js header — no live Stripe price
// exists for Solo/Team at all). An add-on purchase attaches a SECOND, small
// subscription to a customer's EXISTING Stripe customer record — it never
// needs a base-plan price to exist.
//
// POST (Authorization: Bearer <supabase user JWT>)
//   -> { ok: true, url: "https://checkout.stripe.com/..." }
//
// The founding 50%-off is applied server-side based on the caller's own
// subscriptions.plan==='founding' (never trusts a client-supplied discount
// flag) — reuses whatever coupon id is configured in
// STRIPE_FOUNDING_ADDON_COUPON_ID (create once via
// POST /api/admin-stripe-tools { action: "create_coupon", id: "...",
// percent_off: 50, duration: "forever" }).
//
// On checkout.session.completed, api/stripe-webhook.js sets
// subscriptions.email_integration_enabled = true for this user (matched via
// client_reference_id) and records email_integration_stripe_sub_id.
//
// Environment:
//   STRIPE_SECRET_KEY
//   ADDON_EMAIL_INTEGRATION_PRICE_ID   — Stripe price id ($15/mo)
//   STRIPE_FOUNDING_ADDON_COUPON_ID    — optional; when set AND caller is an
//                                         active founding member, applied at
//                                         checkout for the 50% discount
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Owner: Carter, 2026-08-22 (SV-ENG-EMAIL-INTEGRATION-ADDON)

const Stripe = require('stripe');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');
const { detectMailProvider } = require('./_lib/mail-provider-detect');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const ADDON_EMAIL_INTEGRATION_PRICE_ID = process.env.ADDON_EMAIL_INTEGRATION_PRICE_ID;
const STRIPE_FOUNDING_ADDON_COUPON_ID = process.env.STRIPE_FOUNDING_ADDON_COUPON_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;

const SUCCESS_URL = 'https://meetdossie.com/app?addon=email-integration&status=success';
const CANCEL_URL = 'https://meetdossie.com/app?addon=email-integration&status=cancelled';

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
  if (!ADDON_EMAIL_INTEGRATION_PRICE_ID) {
    return res.status(503).json({ ok: false, error: 'Email Integration add-on is not yet purchasable — price not configured.' });
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
    `subscriptions?select=plan,status,stripe_customer_id,email_integration_enabled&user_id=eq.${encodeURIComponent(userId)}&order=updated_at.desc&limit=1`,
  );
  const sub = ok && Array.isArray(data) ? data[0] : null;
  if (!sub) {
    return res.status(400).json({ ok: false, error: 'No active Dossie subscription found — the add-on requires a base plan first.' });
  }
  if (sub.email_integration_enabled) {
    return res.status(400).json({ ok: false, error: 'Email Integration is already active on your account.' });
  }

  // Provider guard — best-effort MX check on the account's own login email,
  // so an unsupported or not-yet-configured provider is told BEFORE payment,
  // not discovered after in Settings. Fails open on anything ambiguous (see
  // api/_lib/mail-provider-detect.js header) — this only ever blocks a
  // confidently-detected case.
  if (email) {
    const { provider: detectedProvider } = await detectMailProvider(email).catch(() => ({ provider: 'unknown' }));
    if (detectedProvider === 'unsupported') {
      return res.status(400).json({
        ok: false,
        error: "Email Integration currently supports Gmail/Google Workspace and Outlook/Microsoft 365 inboxes only. We couldn't confirm your account's inbox is one of those — reach out before purchasing so we don't take payment for something that can't connect.",
      });
    }
    if (detectedProvider === 'microsoft' && !(MICROSOFT_CLIENT_ID && MICROSOFT_CLIENT_SECRET)) {
      return res.status(400).json({
        ok: false,
        error: 'Outlook/Microsoft 365 support is built but not fully turned on yet — hang tight, we\'ll email you the moment it\'s live rather than take payment now.',
      });
    }
  }

  const isActiveFounding = sub.plan === 'founding' && ['active', 'internal', 'pending_onboarding'].includes(sub.status);

  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

  const sessionParams = {
    mode: 'subscription',
    line_items: [{ price: ADDON_EMAIL_INTEGRATION_PRICE_ID, quantity: 1 }],
    success_url: SUCCESS_URL,
    cancel_url: CANCEL_URL,
    client_reference_id: userId,
    metadata: { addon: 'email_integration', user_id: userId },
    subscription_data: { metadata: { addon: 'email_integration', user_id: userId } },
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
    console.error('[create-addon-checkout-session] stripe error', err && err.message);
    return res.status(502).json({ ok: false, error: 'Could not start checkout.' });
  }
};
