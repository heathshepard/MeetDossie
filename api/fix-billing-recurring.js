/**
 * POST /api/fix-billing-recurring
 *
 * Executes Heath's Telegram directive (2026-06-14):
 * A) Retry past-due invoices for: Brittney YBarbo, Suzanne Page
 * B) Create recurring subscriptions for 7 customers without stripe_subscription_id
 *
 * Protected by CRON_SECRET header.
 */

const Stripe = require('stripe');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const FOUNDING_PRICE_ID = 'price_1TPxxNL920SKTEEiN7Gphq8T';

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

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
    throw new Error(`Supabase ${init.method || 'GET'} ${path} (${res.status}): ${text.slice(0, 300)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function main(req, res) {
  // Auth guard
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  // Parse request body
  const { action } = req.body || {};

  if (action === 'retry-group-a') {
    return await handleRetryGroupA(res);
  } else if (action === 'create-group-b') {
    return await handleCreateGroupB(res);
  } else {
    return res.status(400).json({ ok: false, error: 'Unknown action' });
  }
}

async function handleRetryGroupA(res) {
  const results = { charged: [], synced: [], failed: [] };

  // Group A emails: Brittney YBarbo, Suzanne Page
  const groupA = ['brittney@setxrealtors.com', 'suzanne@example.com'];

  for (const email of groupA) {
    try {
      // Get profile by email
      const profiles = await supabaseFetch(
        `/rest/v1/profiles?email=eq.${encodeURIComponent(email.toLowerCase())}&select=*&limit=1`
      );
      if (!Array.isArray(profiles) || profiles.length === 0) {
        results.failed.push({ email, reason: 'profile_not_found' });
        continue;
      }

      const profile = profiles[0];
      if (!profile.stripe_subscription_id) {
        results.failed.push({ email, reason: 'no_subscription_id_in_db' });
        continue;
      }

      // Get subscription from Stripe
      const sub = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);

      if (sub.status === 'past_due' && sub.latest_invoice) {
        // Retry the past-due invoice
        await stripe.invoices.pay(sub.latest_invoice);
        results.charged.push({ email, invoiceId: sub.latest_invoice });
      } else if (sub.status === 'active') {
        // Sync subscription dates
        const currentPeriodEnd = new Date(sub.current_period_end * 1000).toISOString();
        await supabaseFetch(`/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(profile.id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ current_period_end: currentPeriodEnd }),
        });
        results.synced.push({ email });
      } else {
        results.failed.push({ email, reason: `unexpected_status_${sub.status}` });
      }
    } catch (err) {
      results.failed.push({ email, reason: err.message });
    }
  }

  return res.status(200).json({
    ok: true,
    action: 'retry-group-a',
    ...results,
  });
}

async function handleCreateGroupB(res) {
  const results = { created: [], failed: [] };

  const groupB = [
    'natalie@localchoicegroup.com',
    'zelda@a2zrealestateconsultants.com',
    'amanda@amandanuckles.com',
    'cecilia@sterlingassociatesre.com',
    'mikirgvrealtor@gmail.com',
    'kimberlyherrera@kw.com',
    'tgill@phyllisbrowning.com',
  ];

  for (const email of groupB) {
    try {
      // Get profile by email
      const profiles = await supabaseFetch(
        `/rest/v1/profiles?email=eq.${encodeURIComponent(email.toLowerCase())}&select=*&limit=1`
      );
      if (!Array.isArray(profiles) || profiles.length === 0) {
        results.failed.push({ email, reason: 'profile_not_found' });
        continue;
      }

      const profile = profiles[0];

      // Skip if already has subscription
      if (profile.stripe_subscription_id) {
        continue;
      }

      if (!profile.stripe_customer_id) {
        results.failed.push({ email, reason: 'no_stripe_customer_id' });
        continue;
      }

      // Calculate trial_end = created_at + 30 days
      const createdAt = new Date(profile.created_at);
      const trialEndMs = createdAt.getTime() + 30 * 24 * 60 * 60 * 1000;
      const trialEnd = Math.floor(trialEndMs / 1000);

      // Create subscription
      const sub = await stripe.subscriptions.create({
        customer: profile.stripe_customer_id,
        items: [{ price: FOUNDING_PRICE_ID }],
        trial_end: trialEnd,
        proration_behavior: 'none',
      });

      // Update Supabase
      const currentPeriodEnd = new Date(sub.current_period_end * 1000).toISOString();
      await supabaseFetch(`/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(profile.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          stripe_subscription_id: sub.id,
          stripe_customer_id: profile.stripe_customer_id,
          stripe_price_id: FOUNDING_PRICE_ID,
          current_period_end: currentPeriodEnd,
          status: 'active',
        }),
      });

      const trialEndDate = new Date(trialEnd * 1000).toISOString();
      results.created.push({ email, subscriptionId: sub.id, trialEnd: trialEndDate });
    } catch (err) {
      results.failed.push({ email, reason: err.message });
    }
  }

  return res.status(200).json({
    ok: true,
    action: 'create-group-b',
    ...results,
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    return await main(req, res);
  } catch (err) {
    console.error('[fix-billing-recurring]', err);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
};
