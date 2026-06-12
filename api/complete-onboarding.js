// Vercel Serverless Function: /api/complete-onboarding
// Handles post-payment onboarding form submission
// POST { session_id, name, email, brokerage, market } -> { ok: true }
//
// Environment:
//   STRIPE_SECRET_KEY            — Stripe secret key
//   SUPABASE_URL                 — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY    — service-role JWT
//   RESEND_API_KEY               — Resend API key
//   TELEGRAM_MARKETING_BOT_TOKEN — Telegram bot token for notifications
//   TELEGRAM_CHAT_ID             — Heath's Telegram chat ID

const Stripe = require('stripe');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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

function toTitleCase(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

async function supabaseFetch(path, init = {}) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
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

async function findAuthUserIdByEmail(email) {
  if (!email) return null;
  try {
    const encoded = encodeURIComponent(email);
    const data = await supabaseFetch(`/auth/v1/admin/users?email=${encoded}`);
    const users = Array.isArray(data?.users) ? data.users : (Array.isArray(data) ? data : []);
    const match = users.find((u) => String(u.email || '').toLowerCase() === String(email).toLowerCase());
    return match ? match.id : null;
  } catch (err) {
    console.warn('[complete-onboarding] findAuthUserIdByEmail failed:', err && err.message);
    return null;
  }
}

async function createAuthUser({ email, fullName }) {
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
    const body = String(err.body || '').toLowerCase();
    if (err.status === 422 || body.includes('already') || body.includes('registered') || body.includes('exists')) {
      const existing = await findAuthUserIdByEmail(email);
      if (existing) return { userId: existing, created: false };
    }
    throw err;
  }
}

async function generateRecoveryLink(email) {
  if (!email) return null;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = `${SUPABASE_URL}/auth/v1/admin/generate_link`;
  const body = {
    type: 'recovery',
    email,
    redirect_to: 'https://meetdossie.com/set-password.html',
  };
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
    if (!res.ok) {
      console.error('[complete-onboarding] generateRecoveryLink non-OK', res.status, text.slice(0, 500));
      return null;
    }
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (parseErr) {
      console.error('[complete-onboarding] generateRecoveryLink JSON parse failed:', parseErr && parseErr.message);
      return null;
    }
    if (!data) return null;
    if (typeof data.action_link === 'string' && data.action_link) {
      return data.action_link;
    }
    if (data.properties && typeof data.properties.action_link === 'string' && data.properties.action_link) {
      return data.properties.action_link;
    }
    console.error('[complete-onboarding] no action_link in response');
    return null;
  } catch (err) {
    console.error('[complete-onboarding] generateRecoveryLink threw:', err && err.message);
    return null;
  }
}

async function upsertProfile(payload) {
  await supabaseFetch('/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(payload),
  });
}

async function updateSubscriptionByCustomerId(stripeCustomerId, patch) {
  const encoded = encodeURIComponent(stripeCustomerId);
  await supabaseFetch(`/rest/v1/subscriptions?stripe_customer_id=eq.${encoded}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

// Upsert the subscription row keyed on stripe_subscription_id.
// Used as a safety net when complete-onboarding runs before (or instead of)
// the webhook — ensures the row always exists and is 'active' when the customer
// completes their onboarding form.
async function upsertSubscriptionBySubId({
  userId, stripeCustomerId, stripeSubscriptionId, stripePriceId,
  currentPeriodStart, currentPeriodEnd,
}) {
  await supabaseFetch('/rest/v1/subscriptions?on_conflict=stripe_subscription_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      user_id: userId,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      stripe_price_id: stripePriceId || null,
      plan: 'founding',
      status: 'active',
      current_period_start: currentPeriodStart || null,
      current_period_end: currentPeriodEnd || null,
    }),
  });
}

const BRAND_BG = '#FDFCFA';
const BRAND_NAVY = '#1C2B3A';
const BRAND_TEXT_SOFT = '#5C6B7A';
const BRAND_CORAL = '#E8927C';
const BRAND_MUTED = '#9CA8B4';

function welcomeEmailHtml(fullName) {
  const name = (fullName || '').trim().split(' ')[0] || 'there';
  return `<div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 24px; background: ${BRAND_BG}; color: ${BRAND_NAVY};">
  <div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; font-size: 12px; letter-spacing: 2px; color: #A48531; text-transform: uppercase; font-weight: 700; margin-bottom: 18px;">DOSSIE</div>
  <h1 style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 34px; line-height: 1.15; margin: 0 0 24px; color: ${BRAND_NAVY};">${name},</h1>
  <p style="font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 0 0 18px;">Heath here — founder of Dossie, and a licensed Texas REALTOR myself.</p>
  <p style="font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 0 0 18px;">You're officially a founding member. Your $29/mo is locked forever, no matter what we do with pricing for everyone else.</p>
  <p style="font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 0 0 18px;">I want to ask one specific thing in the next 60 seconds: open Dossie, pull up any deal you're working — even a closed one from last month — and drop the contract in.</p>
  <p style="font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 0 0 18px;">She reads it, pulls every TREC deadline with the paragraph it came from, and you'll see your option period, financing contingency, and closing date sitting on the page in clean order. That's the moment most agents text me back saying "okay, I see what this is now."</p>
  <div style="margin: 28px 0; text-align: center;">
    <a href="https://meetdossie.com/app" style="display: inline-block; padding: 16px 32px; background: ${BRAND_CORAL}; color: white; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 15px; font-family: 'Plus Jakarta Sans', Arial, sans-serif; letter-spacing: 0.2px;">Create Your First Dossier</a>
  </div>
  <p style="font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 0 0 12px;"><strong style="color: ${BRAND_NAVY};">Here's the surface area of what you just bought:</strong></p>
  <ol style="font-size: 15px; color: ${BRAND_NAVY}; line-height: 1.8; margin: 0 0 24px; padding-left: 20px;">
    <li><strong>Morning Brief</strong> — 90-second audio at 6am, summarizing what's due, what closed, what needs your eyes.</li>
    <li><strong>Talk to Dossie</strong> — tap the mic in any dossier and just say it: "Draft a follow-up to the lender." She writes the email.</li>
    <li><strong>TREC deadlines, auto-calculated and cited</strong> — every deadline lands with the TREC paragraph it came from.</li>
    <li><strong>DossieSign</strong> — fill TREC forms with the data already in your dossier and send for signature in two clicks.</li>
    <li><strong>Form Packages</strong> — apply the Buyer or Seller bundle and every form you need attaches at once.</li>
    <li><strong>Email and document scanning</strong> — paste an email or upload a PDF and Dossie pulls party names, amounts, dates into the dossier.</li>
    <li><strong>Closing milestone cards</strong> — clean, shareable wins for your social. No client data.</li>
    <li><strong>Compliance Vault</strong> — your brokerage's required docs organized in one place.</li>
  </ol>
  <p style="font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 0 0 18px;">Reply to this email any time. I read every one personally, usually within the hour.</p>
  <p style="font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 0 0 18px;">AI is hitting transaction coordination fast. My take: don't fight it, be part of it. You made that call early — and the founding price locks you in before everyone else catches up.</p>
  <p style="font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 0 0 4px;">Heath</p>
  <p style="font-size: 15px; color: ${BRAND_TEXT_SOFT}; line-height: 1.6; margin: 0 0 18px;">heath@meetdossie.com<br>Licensed Texas REALTOR | Founder, Dossie</p>
  <hr style="border: none; border-top: 1px solid ${BRAND.border}; margin: 24px 0;">
  <p style="font-size: 14px; color: ${BRAND_MUTED}; line-height: 1.6; margin: 0;"><strong>P.S.</strong> — Once you're in the app, join the Founding Files Facebook group. It's where I share what's shipping next and where founding members vote on what to build: <a href="https://www.facebook.com/share/g/1P2QL9T42t/" style="color: ${BRAND_CORAL}; text-decoration: none;">facebook.com/share/g/1P2QL9T42t/</a></p>
</div>`;
}

function setPasswordEmailHtml(actionLink) {
  return `<div style="font-family: 'Cormorant Garamond', Georgia, serif; max-width: 600px; margin: 0 auto; padding: 48px 24px; background: ${BRAND_BG}; color: ${BRAND_NAVY};">
  <div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; font-size: 12px; letter-spacing: 2px; color: #A48531; text-transform: uppercase; font-weight: 700; margin-bottom: 18px;">DOSSIE</div>
  <h1 style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 38px; line-height: 1.15; margin: 0 0 16px; color: ${BRAND_NAVY};">Welcome to Dossie.</h1>
  <p style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 0 0 28px;">Your founding member access is confirmed. Click below to set your password and get started.</p>
  <a href="${actionLink}" style="display: inline-block; padding: 16px 32px; background: #D4A0A0; color: white; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 15px; font-family: 'Plus Jakarta Sans', Arial, sans-serif; letter-spacing: 0.2px;">Set Your Password</a>
  <p style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; margin-top: 36px; font-size: 13px; color: ${BRAND_MUTED}; line-height: 1.6;">This link expires in 1 hour. If it's expired, contact us at heath@meetdossie.com and we'll send a new one. If you didn't request this, ignore this email.</p>
</div>`;
}

async function sendEmail({ to, subject, html }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.warn('[complete-onboarding] RESEND_API_KEY not set — skipping email to', to);
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
        bcc: ['heath@meetdossie.com'],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[complete-onboarding] Resend send failed', res.status, text.slice(0, 300));
    }
  } catch (err) {
    console.error('[complete-onboarding] Resend send threw:', err && err.message);
  }
}

async function notifyHeathOnTelegram({ name, email, phone, brokerage, market, heardFrom }) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[complete-onboarding] Telegram not configured — skipping notification');
    return;
  }

  // NOTE: this fires on onboarding-form completion (account exists, NOT paid).
  // The "🎉 NEW FOUNDING MEMBER" celebration is reserved for stripe-webhook.js,
  // which fires only after a successful Stripe payment. Heath flagged 2026-05-23
  // that the prior duplicate wording made it impossible to tell at a glance
  // whether a notification meant "they paid" vs "they made an account."
  const text = `📝 <b>ONBOARDING FORM SUBMITTED — not yet paid</b>\n\n<b>Name:</b> ${name || 'unknown'}\n<b>Email:</b> ${email || 'unknown'}\n<b>Phone:</b> ${phone || 'unknown'}\n<b>Brokerage:</b> ${brokerage || 'unknown'}\n<b>Market:</b> ${market || 'unknown'}\n<b>Heard from:</b> ${heardFrom || 'unknown'}\n<b>Time:</b> ${new Date().toISOString()}\n\n<i>Account exists in Supabase but no Stripe payment yet. A separate 🎉 notification will fire once they actually pay.</i>`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
      }),
    });

    if (!res.ok) {
      console.error('[complete-onboarding] Telegram notification failed:', res.status);
    }
  } catch (err) {
    console.error('[complete-onboarding] Telegram threw:', err && err.message);
  }
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

  if (!process.env.STRIPE_SECRET_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[complete-onboarding] Missing required environment variables');
    res.status(500).json({ ok: false, error: 'Server not configured.' });
    return;
  }

  const body = req.body || {};
  const sessionId = (body.session_id || '').trim();
  const name = toTitleCase(body.name || '');
  const email = String(body.email || '').trim().toLowerCase();
  const phone = (body.phone || '').trim();
  const brokerage = (body.brokerage || '').trim();
  const market = (body.market || '').trim();
  const heardFrom = (body.heard_from || '').trim();

  if (!sessionId || !sessionId.startsWith('cs_')) {
    res.status(400).json({ ok: false, error: 'Invalid session ID.' });
    return;
  }
  if (!name) {
    res.status(400).json({ ok: false, error: 'Name is required.' });
    return;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ ok: false, error: 'Valid email is required.' });
    return;
  }
  if (!phone) {
    res.status(400).json({ ok: false, error: 'Phone is required.' });
    return;
  }
  if (!brokerage) {
    res.status(400).json({ ok: false, error: 'Brokerage is required.' });
    return;
  }
  if (!market) {
    res.status(400).json({ ok: false, error: 'Market is required.' });
    return;
  }
  if (!heardFrom) {
    res.status(400).json({ ok: false, error: 'Please tell us how you heard about Dossie.' });
    return;
  }

  try {
    // Retrieve Stripe session to get customer ID and subscription ID
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!session || !session.customer) {
      res.status(404).json({ ok: false, error: 'Checkout session not found.' });
      return;
    }

    const stripeCustomerId = typeof session.customer === 'string'
      ? session.customer
      : session.customer.id;

    // Also resolve the subscription ID and period dates from Stripe so we can
    // upsert the subscription row even if the webhook hasn't fired yet.
    const stripeSubscriptionId = typeof session.subscription === 'string'
      ? session.subscription
      : (session.subscription && session.subscription.id) || null;

    let currentPeriodStart = null;
    let currentPeriodEnd = null;
    let stripePriceId = null;
    if (stripeSubscriptionId) {
      try {
        const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
        if (sub && sub.current_period_start) {
          currentPeriodStart = new Date(sub.current_period_start * 1000).toISOString();
        }
        if (sub && sub.current_period_end) {
          currentPeriodEnd = new Date(sub.current_period_end * 1000).toISOString();
        }
        stripePriceId = sub?.items?.data?.[0]?.price?.id || null;
      } catch (err) {
        console.warn('[complete-onboarding] subscriptions.retrieve failed:', err && err.message);
      }
    }

    // Create Supabase auth user
    const result = await createAuthUser({ email, fullName: name });
    const userId = result.userId;

    if (!userId) {
      throw new Error('Failed to create auth user.');
    }

    // Upsert profile with brokerage, market, phone, and heard_from
    await upsertProfile({
      id: userId,
      email,
      full_name: name,
      phone,
      brokerage,
      market,
      heard_from: heardFrom,
      subscription_tier: 'founding',
      subscription_status: 'active',
      plan: 'founding',
      stripe_customer_id: stripeCustomerId,
    });

    // Upsert subscription row keyed on stripe_subscription_id.
    // This is the authoritative write: if the webhook already created the row
    // (status=pending_onboarding), this upgrades it to active and fills in the
    // user_id. If the webhook never fired, this creates the row from scratch.
    // Falls back to PATCH by customer_id if we have no subscription_id.
    if (stripeSubscriptionId) {
      await upsertSubscriptionBySubId({
        userId,
        stripeCustomerId,
        stripeSubscriptionId,
        stripePriceId,
        currentPeriodStart,
        currentPeriodEnd,
      });
      console.log('[complete-onboarding] subscription upserted by stripe_subscription_id for', email, 'sub=', stripeSubscriptionId);
    } else {
      // Fallback: patch by customer ID (works if webhook created the row).
      // If no row exists, this silently does nothing — the reconcile cron will catch it.
      await updateSubscriptionByCustomerId(stripeCustomerId, {
        user_id: userId,
        status: 'active',
      });
      console.warn('[complete-onboarding] no stripe_subscription_id on session — fell back to PATCH by customer_id for', email);
    }

    // Send welcome email
    await sendEmail({
      to: email,
      subject: 'Welcome to Dossie — let\'s get you set up',
      html: welcomeEmailHtml(name),
    });

    // Generate recovery link and send password-set email
    const actionLink = await generateRecoveryLink(email);
    if (actionLink) {
      await sendEmail({
        to: email,
        subject: 'Welcome to Dossie — Set Your Password',
        html: setPasswordEmailHtml(actionLink),
      });
    } else {
      console.error('[complete-onboarding] no action_link returned for', email);
    }

    // Notify Heath via Telegram
    await notifyHeathOnTelegram({ name, email, phone, brokerage, market, heardFrom });

    res.status(200).json({ ok: true, message: 'Onboarding complete.' });
  } catch (err) {
    console.error('[complete-onboarding] error:', err && err.message);
    res.status(500).json({
      ok: false,
      error: err && err.message || 'Failed to complete onboarding.',
    });
  }
};
