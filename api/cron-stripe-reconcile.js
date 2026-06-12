// Vercel Serverless Function: /api/cron-stripe-reconcile
// Nightly safety net: reconciles active Stripe founding subscriptions against
// the Supabase subscriptions table. Any customer who paid but was never
// provisioned (webhook gap) gets a subscription row created automatically.
//
// Logic:
//   1. Fetch all active Stripe subscriptions with price_id = FOUNDING_PRICE_ID.
//   2. For each, check if a subscriptions row exists by stripe_subscription_id.
//   3. If missing: look up or create the auth user, then insert the row.
//   4. Send a Telegram alert to Heath listing every gap fixed (or "all clear").
//   5. Log each gap to ventures_activity_events for audit trail.
//
// Auth: Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: NOT in vercel.json crons array — trigger via cron-job.org at
//           06:00 UTC daily (1:00 AM CST). Manual: curl -H "Authorization:
//           Bearer $CRON_SECRET" https://meetdossie.com/api/cron-stripe-reconcile
//
// Environment:
//   STRIPE_SECRET_KEY            — Stripe secret key
//   SUPABASE_URL                 — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY    — service-role JWT
//   TELEGRAM_BOT_TOKEN           — Claudy bot token for Heath alerts
//   TELEGRAM_CHAT_ID             — Heath's Telegram chat ID
//   CRON_SECRET                  — bearer token for manual auth

const Stripe = require('stripe');
const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_MARKETING_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const FOUNDING_PRICE_ID = 'price_1TPxxNL920SKTEEiN7Gphq8T';

// ---------------------------------------------------------------------------
// Supabase helpers — direct REST fetch, no supabase-js
// ---------------------------------------------------------------------------

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

// ---------------------------------------------------------------------------
// Auth user helpers
// ---------------------------------------------------------------------------

async function findAuthUserIdByEmail(email) {
  if (!email) return null;
  try {
    const encoded = encodeURIComponent(email);
    const r = await supabaseFetch(`/auth/v1/admin/users?email=${encoded}`);
    if (!r.ok) return null;
    const users = Array.isArray(r.data?.users) ? r.data.users : (Array.isArray(r.data) ? r.data : []);
    const match = users.find((u) => String(u.email || '').toLowerCase() === String(email).toLowerCase());
    return match ? match.id : null;
  } catch (err) {
    console.warn('[cron-stripe-reconcile] findAuthUserIdByEmail failed:', err && err.message);
    return null;
  }
}

function toTitleCase(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

async function createAuthUser({ email, fullName }) {
  const buf = require('crypto').randomBytes(36);
  const unusablePassword = buf.toString('base64').replace(/[+/=]/g, '').slice(0, 48);
  try {
    const r = await supabaseFetch('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: unusablePassword,
        email_confirm: true,
        user_metadata: { full_name: fullName || '' },
      }),
    });
    if (r.ok && r.data && r.data.id) return { userId: r.data.id, created: true };
    if (r.ok && r.data && r.data.user && r.data.user.id) return { userId: r.data.user.id, created: true };
    // 422 = already registered — recover by email lookup
    if (!r.ok) {
      const bodyStr = typeof r.data === 'string' ? r.data : JSON.stringify(r.data || '');
      if (r.status === 422 || bodyStr.toLowerCase().includes('already') || bodyStr.toLowerCase().includes('registered')) {
        const existing = await findAuthUserIdByEmail(email);
        if (existing) return { userId: existing, created: false };
      }
    }
    return { userId: null, created: false };
  } catch (err) {
    console.warn('[cron-stripe-reconcile] createAuthUser threw:', err && err.message);
    return { userId: null, created: false };
  }
}

// ---------------------------------------------------------------------------
// Supabase subscription check + insert
// ---------------------------------------------------------------------------

// Returns true if a subscriptions row already exists for this stripe_subscription_id.
async function subscriptionRowExists(stripeSubscriptionId) {
  if (!stripeSubscriptionId) return false;
  const encoded = encodeURIComponent(stripeSubscriptionId);
  const r = await supabaseFetch(
    `/rest/v1/subscriptions?stripe_subscription_id=eq.${encoded}&select=id&limit=1`,
  );
  return r.ok && Array.isArray(r.data) && r.data.length > 0;
}

// Insert a new subscription row. Uses ON CONFLICT DO NOTHING (idempotent).
async function insertSubscriptionRow({
  userId, stripeCustomerId, stripeSubscriptionId, stripePriceId,
  currentPeriodStart, currentPeriodEnd,
}) {
  const r = await supabaseFetch('/rest/v1/subscriptions?on_conflict=stripe_subscription_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({
      user_id: userId,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      stripe_price_id: stripePriceId,
      plan: 'founding',
      status: 'active',
      current_period_start: currentPeriodStart,
      current_period_end: currentPeriodEnd,
    }),
  });
  return r;
}

// Also patch the profiles row so subscription_status reflects 'active'.
async function patchProfileByUserId(userId) {
  if (!userId) return;
  const encoded = encodeURIComponent(userId);
  await supabaseFetch(`/rest/v1/profiles?id=eq.${encoded}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ subscription_status: 'active', plan: 'founding', subscription_tier: 'founding' }),
  });
}

// ---------------------------------------------------------------------------
// ventures_activity_events logging
// ---------------------------------------------------------------------------

async function logActivity({ summary, detail }) {
  try {
    await supabaseFetch('/rest/v1/ventures_activity_events', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        agent_name: 'cron-stripe-reconcile',
        company: 'Dossie',
        event_type: 'stripe_reconcile',
        summary,
        detail,
      }),
    });
  } catch (err) {
    console.warn('[cron-stripe-reconcile] logActivity failed:', err && err.message);
  }
}

// ---------------------------------------------------------------------------
// Telegram alert
// ---------------------------------------------------------------------------

async function sendTelegramAlert(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[cron-stripe-reconcile] Telegram not configured — skipping alert');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error('[cron-stripe-reconcile] Telegram alert failed:', res.status, t.slice(0, 200));
    }
  } catch (err) {
    console.error('[cron-stripe-reconcile] Telegram alert threw:', err && err.message);
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

module.exports = withTelemetry('cron-stripe-reconcile', async function handler(req, res) {
  // Auth: accept Vercel's built-in cron header OR manual Bearer token.
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!STRIPE_SECRET_KEY) {
    return res.status(500).json({ ok: false, error: 'STRIPE_SECRET_KEY not configured' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

  console.log('[cron-stripe-reconcile] starting reconcile run at', new Date().toISOString());

  // Fetch all active Stripe subscriptions for the founding price.
  // Stripe paginates at 100 items — loop through all pages.
  const allStripeSubs = [];
  let startingAfter = undefined;
  let page = 0;
  try {
    while (true) {
      page += 1;
      const params = {
        price: FOUNDING_PRICE_ID,
        status: 'active',
        limit: 100,
      };
      if (startingAfter) params.starting_after = startingAfter;

      const list = await stripe.subscriptions.list(params);
      console.log(`[cron-stripe-reconcile] page ${page}: fetched ${list.data.length} subscriptions`);
      allStripeSubs.push(...list.data);

      if (!list.has_more) break;
      startingAfter = list.data[list.data.length - 1].id;
    }
  } catch (err) {
    console.error('[cron-stripe-reconcile] Stripe subscriptions.list failed:', err && err.message);
    return res.status(500).json({ ok: false, error: 'Failed to fetch Stripe subscriptions: ' + String(err && err.message || err) });
  }

  console.log(`[cron-stripe-reconcile] total active founding subscriptions in Stripe: ${allStripeSubs.length}`);

  const gaps = [];         // subscriptions fixed this run
  const errors = [];       // subscriptions that failed to fix
  let alreadyProvisioned = 0;
  let skippedDemoAccounts = 0;

  for (const sub of allStripeSubs) {
    const stripeSubscriptionId = sub.id;
    const stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id) || null;
    const stripePriceId = sub?.items?.data?.[0]?.price?.id || FOUNDING_PRICE_ID;

    const currentPeriodStart = sub.current_period_start
      ? new Date(sub.current_period_start * 1000).toISOString() : null;
    const currentPeriodEnd = sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString() : null;

    // Idempotency: if row exists, skip.
    let rowExists = false;
    try {
      rowExists = await subscriptionRowExists(stripeSubscriptionId);
    } catch (err) {
      console.warn('[cron-stripe-reconcile] subscriptionRowExists check failed for', stripeSubscriptionId, ':', err && err.message);
    }

    if (rowExists) {
      alreadyProvisioned += 1;
      continue;
    }

    // Gap detected — this Stripe subscription has no Supabase row.
    console.log('[cron-stripe-reconcile] GAP detected: sub=', stripeSubscriptionId, 'customer=', stripeCustomerId);

    // Resolve customer email from Stripe.
    let customerEmail = null;
    let customerName = '';
    if (stripeCustomerId) {
      try {
        const customer = await stripe.customers.retrieve(stripeCustomerId);
        if (customer && !customer.deleted) {
          customerEmail = customer.email ? String(customer.email).toLowerCase() : null;
          customerName = toTitleCase(customer.name || '');
        }
      } catch (err) {
        console.warn('[cron-stripe-reconcile] customers.retrieve failed for', stripeCustomerId, ':', err && err.message);
      }
    }

    if (!customerEmail) {
      const errMsg = `No customer email found for sub=${stripeSubscriptionId} customer=${stripeCustomerId}`;
      console.error('[cron-stripe-reconcile]', errMsg);
      errors.push({ stripeSubscriptionId, stripeCustomerId, error: errMsg });
      continue;
    }

    // Skip demo accounts.
    if (customerEmail === 'demo@meetdossie.com' || customerEmail === 'demo2@meetdossie.com' || customerEmail === 'heath.shepard@gmail.com') {
      console.log('[cron-stripe-reconcile] skipping demo/test account:', customerEmail);
      skippedDemoAccounts += 1;
      continue;
    }

    // Resolve or create auth user.
    let userId = null;
    try {
      userId = await findAuthUserIdByEmail(customerEmail);
      if (!userId) {
        const result = await createAuthUser({ email: customerEmail, fullName: customerName });
        userId = result.userId;
        console.log('[cron-stripe-reconcile] created placeholder auth user for', customerEmail, 'userId=', userId);
      } else {
        console.log('[cron-stripe-reconcile] found existing auth user for', customerEmail, 'userId=', userId);
      }
    } catch (err) {
      const errMsg = `Failed to resolve userId for ${customerEmail}: ${err && err.message}`;
      console.error('[cron-stripe-reconcile]', errMsg);
      errors.push({ stripeSubscriptionId, customerEmail, error: errMsg });
      continue;
    }

    if (!userId) {
      const errMsg = `No userId resolved for ${customerEmail}`;
      console.error('[cron-stripe-reconcile]', errMsg);
      errors.push({ stripeSubscriptionId, customerEmail, error: errMsg });
      continue;
    }

    // Insert the missing subscription row.
    try {
      const ins = await insertSubscriptionRow({
        userId, stripeCustomerId, stripeSubscriptionId, stripePriceId,
        currentPeriodStart, currentPeriodEnd,
      });
      if (!ins.ok) {
        const errMsg = `Insert failed status=${ins.status} body=${JSON.stringify(ins.data).slice(0, 200)}`;
        console.error('[cron-stripe-reconcile]', errMsg, 'for', customerEmail);
        errors.push({ stripeSubscriptionId, customerEmail, error: errMsg });
        continue;
      }
      console.log('[cron-stripe-reconcile] inserted subscription row for', customerEmail, 'sub=', stripeSubscriptionId);
    } catch (err) {
      const errMsg = `Insert threw: ${err && err.message}`;
      console.error('[cron-stripe-reconcile]', errMsg, 'for', customerEmail);
      errors.push({ stripeSubscriptionId, customerEmail, error: errMsg });
      continue;
    }

    // Patch the profile row to reflect active subscription.
    try {
      await patchProfileByUserId(userId);
    } catch (err) {
      console.warn('[cron-stripe-reconcile] patchProfileByUserId failed for', userId, ':', err && err.message);
      // Non-fatal — subscription row is already written; profile patch can be retried.
    }

    gaps.push({ stripeSubscriptionId, stripeCustomerId, customerEmail, customerName, userId });

    // Log to ventures_activity_events.
    await logActivity({
      summary: `Reconcile gap fixed: ${customerEmail} (sub ${stripeSubscriptionId})`,
      detail: { stripeSubscriptionId, stripeCustomerId, customerEmail, userId },
    });
  }

  console.log(`[cron-stripe-reconcile] done — ${alreadyProvisioned} already provisioned, ${gaps.length} gaps fixed, ${skippedDemoAccounts} demo/test accounts skipped, ${errors.length} errors`);

  // Send Telegram alert.
  let telegramText;
  if (gaps.length === 0 && errors.length === 0) {
    telegramText = `Stripe reconcile (${new Date().toISOString().slice(0, 10)}): all clear. ${alreadyProvisioned} already provisioned${skippedDemoAccounts > 0 ? `, ${skippedDemoAccounts} demo/test skipped` : ''}.`;
  } else {
    const gapLines = gaps.map((g) => `  - ${g.customerEmail} (sub ${g.stripeSubscriptionId})`).join('\n');
    const errLines = errors.map((e) => `  - ${e.customerEmail || e.stripeSubscriptionId}: ${e.error}`).join('\n');
    telegramText = [
      `<b>Stripe reconcile ${new Date().toISOString().slice(0, 10)}</b>`,
      gaps.length > 0 ? `\nGaps FIXED (${gaps.length}):\n${gapLines}` : '',
      errors.length > 0 ? `\nErrors (${errors.length}):\n${errLines}` : '',
      `\n${alreadyProvisioned} already provisioned${skippedDemoAccounts > 0 ? `, ${skippedDemoAccounts} demo/test skipped` : ''}.`,
    ].filter(Boolean).join('');
  }

  await sendTelegramAlert(telegramText);

  return res.status(200).json({
    ok: true,
    ran_at: new Date().toISOString(),
    total_stripe_subs: allStripeSubs.length,
    already_provisioned: alreadyProvisioned,
    gaps_fixed: gaps.length,
    demo_accounts_skipped: skippedDemoAccounts,
    errors: errors.length,
    gaps,
    error_details: errors,
  });
});
