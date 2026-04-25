// Vercel Serverless Function: /api/stripe-webhook
// Receives Stripe webhook events. On checkout.session.completed:
//   - upserts a row in `subscriptions` (keyed by stripe_subscription_id)
//   - flips the matching `profiles` row to plan="founding", subscription_status="active"
// Returns 200 on success, 400 on signature failure.
//
// Environment:
//   STRIPE_SECRET_KEY          — Stripe secret key
//   STRIPE_WEBHOOK_SECRET      — webhook signing secret (whsec_...)
//   SUPABASE_URL               — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY  — service-role JWT (server-side only)

const Stripe = require('stripe');

// Stripe requires the raw request body for signature verification, so disable
// Vercel's default JSON parser on this route.
module.exports.config = { api: { bodyParser: false } };

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function supabaseFetch(path, init = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${init.method || 'GET'} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function findUserIdByEmail(email) {
  if (!email) return null;
  const encoded = encodeURIComponent(email);
  const rows = await supabaseFetch(`/rest/v1/profiles?email=eq.${encoded}&select=id&limit=1`);
  if (Array.isArray(rows) && rows.length > 0) return rows[0].id;
  return null;
}

async function upsertSubscription(payload) {
  await supabaseFetch('/rest/v1/subscriptions?on_conflict=stripe_subscription_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(payload),
  });
}

async function updateProfile(userId, patch) {
  const encoded = encodeURIComponent(userId);
  await supabaseFetch(`/rest/v1/profiles?id=eq.${encoded}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

async function handleCheckoutSessionCompleted(stripe, session) {
  const customerEmail = (session.customer_details && session.customer_details.email)
    || session.customer_email
    || null;
  const stripeCustomerId = typeof session.customer === 'string'
    ? session.customer
    : (session.customer && session.customer.id) || null;
  const stripeSubscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : (session.subscription && session.subscription.id) || null;

  let currentPeriodStart = null;
  let currentPeriodEnd = null;
  if (stripeSubscriptionId) {
    try {
      const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
      if (sub && sub.current_period_start) {
        currentPeriodStart = new Date(sub.current_period_start * 1000).toISOString();
      }
      if (sub && sub.current_period_end) {
        currentPeriodEnd = new Date(sub.current_period_end * 1000).toISOString();
      }
    } catch (err) {
      console.warn('[stripe-webhook] subscriptions.retrieve failed:', err && err.message);
    }
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[stripe-webhook] Supabase not configured — skipping persistence.');
    return;
  }

  let userId = null;
  if (customerEmail) {
    try {
      userId = await findUserIdByEmail(String(customerEmail).toLowerCase());
    } catch (err) {
      console.warn('[stripe-webhook] profile lookup failed:', err && err.message);
    }
  }

  try {
    await upsertSubscription({
      user_id: userId,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      plan: 'founding',
      status: 'active',
      current_period_start: currentPeriodStart,
      current_period_end: currentPeriodEnd,
    });
  } catch (err) {
    console.error('[stripe-webhook] subscription upsert failed:', err && err.message);
  }

  if (userId) {
    try {
      await updateProfile(userId, {
        plan: 'founding',
        subscription_status: 'active',
        stripe_customer_id: stripeCustomerId,
      });
    } catch (err) {
      console.error('[stripe-webhook] profile update failed:', err && err.message);
    }
  } else if (customerEmail) {
    console.warn(
      '[stripe-webhook] no profiles row matched email',
      customerEmail,
      '— subscription row written without user_id.',
    );
  }
}

module.exports = async function handler(req, res) {
  // Stripe reaches this from its own infrastructure, not a browser, so CORS
  // is permissive. Browser callers are not expected to hit this endpoint.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }

  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
    console.error('[stripe-webhook] STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET not set.');
    res.status(500).json({ ok: false, error: 'Webhook is not configured.' });
    return;
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

  let event;
  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed:', err && err.message);
    res.status(400).json({ ok: false, error: `Webhook signature verification failed: ${err && err.message}` });
    return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      await handleCheckoutSessionCompleted(stripe, event.data.object);
    }
    res.status(200).json({ ok: true, received: event.type });
  } catch (err) {
    console.error('[stripe-webhook] handler error:', err && err.message);
    // Still return 200 so Stripe doesn't retry on a downstream issue we've
    // already logged — signature was valid, the event was acknowledged.
    res.status(200).json({ ok: true, received: event.type, warning: 'handler error logged' });
  }
};
