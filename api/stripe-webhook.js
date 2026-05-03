// Vercel Serverless Function: /api/stripe-webhook
// Handles Stripe webhook events:
//   - checkout.session.completed → create Supabase auth user (if new),
//     upsert profile + subscription rows, send welcome + password emails.
//   - customer.subscription.deleted → mark profile subscription_status = 'cancelled'.
// Returns 200 on success, 400 on signature failure.
//
// Environment:
//   STRIPE_SECRET_KEY          — Stripe secret key
//   STRIPE_WEBHOOK_SECRET      — webhook signing secret (whsec_...)
//   SUPABASE_URL               — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY  — service-role JWT (server-side only)
//   RESEND_API_KEY             — Resend API key for transactional email

const Stripe = require('stripe');

// Stripe requires the raw request body for signature verification, so disable
// Vercel's default JSON parser on this route.
module.exports.config = { api: { bodyParser: false } };

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const PRICE_TIERS = {
  'price_1TPxxNL920SKTEEiN7Gphq8T': 'founding',
};

// Stripe checkout names arrive in whatever case the customer typed
// ("heath Shepard", "HEATH SHEPARD"). Normalize on the way in so the Settings
// page and email greetings never display a mid-cap or shouting name.
function toTitleCase(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

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
    const err = new Error(`Supabase ${init.method || 'GET'} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
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

// Look up a Supabase auth user by email via the Admin API. Returns null if
// none exists. Used as a recovery path when createUser reports a duplicate.
async function findAuthUserIdByEmail(email) {
  if (!email) return null;
  try {
    const encoded = encodeURIComponent(email);
    const data = await supabaseFetch(`/auth/v1/admin/users?email=${encoded}`);
    const users = Array.isArray(data?.users) ? data.users : (Array.isArray(data) ? data : []);
    const match = users.find((u) => String(u.email || '').toLowerCase() === String(email).toLowerCase());
    return match ? match.id : null;
  } catch (err) {
    console.warn('[stripe-webhook] findAuthUserIdByEmail failed:', err && err.message);
    return null;
  }
}

// Create a Supabase auth user. Returns { userId, created } where created=false
// means the user already existed and we recovered their id by email lookup.
async function createAuthUser({ email, fullName }) {
  // Random unusable password — the user will set their own via the recovery link.
  // Never sent to the user, never logged. 48 url-safe chars.
  const buf = require('crypto').randomBytes(36);
  const unusablePassword = buf.toString('base64').replace(/[+/=]/g, '').slice(0, 48);
  try {
    const data = await supabaseFetch('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: unusablePassword,
        email_confirm: true,
        user_metadata: { full_name: fullName || '' },
      }),
    });
    if (data && data.id) return { userId: data.id, created: true };
    if (data && data.user && data.user.id) return { userId: data.user.id, created: true };
    return { userId: null, created: false };
  } catch (err) {
    // Duplicate email — find the existing user instead of failing the whole webhook.
    const body = String(err.body || '').toLowerCase();
    if (err.status === 422 || body.includes('already') || body.includes('registered') || body.includes('exists')) {
      const existing = await findAuthUserIdByEmail(email);
      if (existing) return { userId: existing, created: false };
    }
    throw err;
  }
}

// Generate a one-time recovery (password-set) link via Supabase Admin API.
// Returns the action_link the user clicks to land on /set-password.html with
// their session tokens in the URL hash. The GoTrue admin endpoint expects
// `redirect_to` at the top level (snake_case); options.redirectTo is the
// JS SDK convention, not the raw HTTP body shape, so do not nest it.
async function generateRecoveryLink(email) {
  if (!email) return null;
  const url = `${SUPABASE_URL}/auth/v1/admin/generate_link`;
  const body = {
    type: 'recovery',
    email,
    redirect_to: 'https://meetdossie.com/set-password.html',
  };
  console.log('[stripe-webhook] generateRecoveryLink → POST /auth/v1/admin/generate_link type=recovery redirect_to=https://meetdossie.com/set-password.html');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log('[stripe-webhook] generateRecoveryLink ← status', res.status, 'body length', text.length);
    if (!res.ok) {
      console.error('[stripe-webhook] generateRecoveryLink non-OK', res.status, text.slice(0, 500));
      return null;
    }
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (parseErr) {
      console.error('[stripe-webhook] generateRecoveryLink JSON parse failed:', parseErr && parseErr.message, '| raw:', text.slice(0, 200));
      return null;
    }
    if (!data) {
      console.error('[stripe-webhook] generateRecoveryLink empty response body');
      return null;
    }
    const topKeys = Object.keys(data).join(',');
    console.log('[stripe-webhook] generateRecoveryLink response keys:', topKeys);
    if (typeof data.action_link === 'string' && data.action_link) {
      console.log('[stripe-webhook] generateRecoveryLink: matched top-level action_link');
      return data.action_link;
    }
    if (data.properties && typeof data.properties.action_link === 'string' && data.properties.action_link) {
      console.log('[stripe-webhook] generateRecoveryLink: matched properties.action_link');
      return data.properties.action_link;
    }
    console.error('[stripe-webhook] generateRecoveryLink: no action_link in response. Keys:', topKeys);
    return null;
  } catch (err) {
    console.error('[stripe-webhook] generateRecoveryLink threw:', err && err.message);
    return null;
  }
}

async function upsertSubscription(payload) {
  await supabaseFetch('/rest/v1/subscriptions?on_conflict=stripe_subscription_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(payload),
  });
}

async function upsertProfile(payload) {
  await supabaseFetch('/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(payload),
  });
}

async function updateProfileByEmail(email, patch) {
  if (!email) return;
  const encoded = encodeURIComponent(String(email).toLowerCase());
  await supabaseFetch(`/rest/v1/profiles?email=eq.${encoded}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

const BRAND_BG = '#FDFCFA';
const BRAND_NAVY = '#1C2B3A';
const BRAND_TEXT_SOFT = '#5C6B7A';
const BRAND_CORAL = '#E8927C';
const BRAND_MUTED = '#9CA8B4';

function welcomeEmailHtml(fullName) {
  const name = (fullName || '').trim() || 'there';
  return `<div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: ${BRAND_BG};">
  <h1 style="font-size: 32px; color: ${BRAND_NAVY};">Hi ${name},</h1>
  <p style="font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7;">I'm Dossie — your new AI transaction coordinator. I work nights, weekends, and holidays so your deals never stop moving.</p>
  <p style="font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7;">Here's how to get started:</p>
  <ol style="font-size: 15px; color: ${BRAND_NAVY}; line-height: 2;">
    <li>Complete your agent profile in Settings</li>
    <li>Open your first dossier — type it or just tell me</li>
    <li>Upload your contract and I'll scan it automatically</li>
    <li>Talk to me anytime — I'm always on</li>
  </ol>
  <a href="https://meetdossie.com/app.html" style="display: inline-block; margin-top: 24px; padding: 14px 28px; background: ${BRAND_CORAL}; color: white; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 15px;">Open Dossie</a>
  <p style="margin-top: 40px; font-size: 13px; color: ${BRAND_MUTED};">I've got the rest. — Dossie</p>
</div>`;
}

function setPasswordEmailHtml(actionLink) {
  return `<div style="font-family: 'Cormorant Garamond', Georgia, serif; max-width: 600px; margin: 0 auto; padding: 48px 24px; background: ${BRAND_BG}; color: ${BRAND_NAVY};">
  <div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; font-size: 12px; letter-spacing: 2px; color: #A48531; text-transform: uppercase; font-weight: 700; margin-bottom: 18px;">DOSSIE</div>
  <h1 style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 38px; line-height: 1.15; margin: 0 0 16px; color: ${BRAND_NAVY};">Welcome to Dossie.</h1>
  <p style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 0 0 28px;">Your founding member access is confirmed. Click below to set your password and get started.</p>
  <a href="${actionLink}" style="display: inline-block; padding: 16px 32px; background: #D4A0A0; color: white; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 15px; font-family: 'Plus Jakarta Sans', Arial, sans-serif; letter-spacing: 0.2px;">Set Your Password</a>
  <p style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; margin-top: 36px; font-size: 13px; color: ${BRAND_MUTED}; line-height: 1.6;">This link expires in 24 hours. If you didn't request this, ignore this email.</p>
</div>`;
}

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.warn('[stripe-webhook] RESEND_API_KEY not set — skipping email to', to);
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Dossie <dossie@meetdossie.com>',
        to: [to],
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[stripe-webhook] Resend send failed', res.status, text.slice(0, 300));
    }
  } catch (err) {
    console.error('[stripe-webhook] Resend send threw:', err && err.message);
  }
}

async function handleCheckoutSessionCompleted(stripe, session) {
  const customerEmailRaw = (session.customer_details && session.customer_details.email)
    || session.customer_email
    || null;
  const customerEmail = customerEmailRaw ? String(customerEmailRaw).toLowerCase() : null;
  const customerName = toTitleCase((session.customer_details && session.customer_details.name) || '');
  const stripeCustomerId = typeof session.customer === 'string'
    ? session.customer
    : (session.customer && session.customer.id) || null;
  const stripeSubscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : (session.subscription && session.subscription.id) || null;

  let currentPeriodStart = null;
  let currentPeriodEnd = null;
  let priceId = null;
  if (stripeSubscriptionId) {
    try {
      const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
      if (sub && sub.current_period_start) {
        currentPeriodStart = new Date(sub.current_period_start * 1000).toISOString();
      }
      if (sub && sub.current_period_end) {
        currentPeriodEnd = new Date(sub.current_period_end * 1000).toISOString();
      }
      priceId = sub?.items?.data?.[0]?.price?.id || null;
    } catch (err) {
      console.warn('[stripe-webhook] subscriptions.retrieve failed:', err && err.message);
    }
  }
  const tier = (priceId && PRICE_TIERS[priceId]) || 'founding';

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[stripe-webhook] Supabase not configured — skipping persistence.');
    return;
  }
  if (!customerEmail) {
    console.error('[stripe-webhook] checkout session has no email; cannot provision user.');
    return;
  }

  // Find or create the auth user.
  let userId = null;
  try {
    userId = await findUserIdByEmail(customerEmail);
  } catch (err) {
    console.warn('[stripe-webhook] profile lookup failed:', err && err.message);
  }
  if (!userId) {
    try {
      const result = await createAuthUser({ email: customerEmail, fullName: customerName });
      userId = result.userId;
    } catch (err) {
      console.error('[stripe-webhook] createAuthUser failed:', err && err.message);
    }
  }

  // Upsert profile (covers both new-user and pre-existing-user cases).
  if (userId) {
    try {
      await upsertProfile({
        id: userId,
        email: customerEmail,
        full_name: customerName || null,
        subscription_tier: tier,
        subscription_status: 'active',
        plan: tier,
        stripe_customer_id: stripeCustomerId,
      });
    } catch (err) {
      console.error('[stripe-webhook] profile upsert failed:', err && err.message);
    }
  }

  // Upsert subscription row.
  try {
    await upsertSubscription({
      user_id: userId,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      plan: tier,
      status: 'active',
      current_period_start: currentPeriodStart,
      current_period_end: currentPeriodEnd,
    });
  } catch (err) {
    console.error('[stripe-webhook] subscription upsert failed:', err && err.message);
  }

  // Send welcome email to everyone who completes checkout.
  await sendEmail({
    to: customerEmail,
    subject: 'Welcome to Dossie',
    html: welcomeEmailHtml(customerName),
  });

  // Always generate a recovery link and send the "Set Your Password" email.
  // Recovery links work for both new users (initial password setup) and
  // existing users (password reset), so this also covers customers whose
  // auth record was created in a prior failed attempt — they were silently
  // dropped before. If generation still fails, log loudly so we can recover
  // them manually via the Supabase dashboard.
  const actionLink = await generateRecoveryLink(customerEmail);
  if (actionLink) {
    await sendEmail({
      to: customerEmail,
      subject: 'Welcome to Dossie — Set Your Password',
      html: setPasswordEmailHtml(actionLink),
    });
  } else {
    console.error('[stripe-webhook] no action_link returned for', customerEmail, '— manual intervention needed.');
  }
}

async function handleSubscriptionDeleted(subscription) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[stripe-webhook] Supabase not configured — skipping cancellation.');
    return;
  }
  const stripeCustomerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : (subscription.customer && subscription.customer.id) || null;

  // Mark subscription row cancelled by stripe_subscription_id.
  if (subscription.id) {
    try {
      const encoded = encodeURIComponent(subscription.id);
      await supabaseFetch(`/rest/v1/subscriptions?stripe_subscription_id=eq.${encoded}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'cancelled' }),
      });
    } catch (err) {
      console.error('[stripe-webhook] subscription cancel patch failed:', err && err.message);
    }
  }

  // Look up the customer's email via Stripe and mark profile cancelled.
  let customerEmail = null;
  if (stripeCustomerId) {
    try {
      const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
      const customer = await stripe.customers.retrieve(stripeCustomerId);
      if (customer && !customer.deleted) {
        customerEmail = customer.email ? String(customer.email).toLowerCase() : null;
      }
    } catch (err) {
      console.warn('[stripe-webhook] customers.retrieve failed:', err && err.message);
    }
  }

  if (customerEmail) {
    try {
      await updateProfileByEmail(customerEmail, { subscription_status: 'cancelled' });
    } catch (err) {
      console.error('[stripe-webhook] profile cancel patch failed:', err && err.message);
    }
  } else {
    console.warn('[stripe-webhook] subscription deleted but customer email unknown; profile not updated.');
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
    } else if (event.type === 'customer.subscription.deleted') {
      await handleSubscriptionDeleted(event.data.object);
    }
    res.status(200).json({ ok: true, received: event.type });
  } catch (err) {
    console.error('[stripe-webhook] handler error:', err && err.message);
    // Still return 200 so Stripe doesn't retry on a downstream issue we've
    // already logged — signature was valid, the event was acknowledged.
    res.status(200).json({ ok: true, received: event.type, warning: 'handler error logged' });
  }
};
