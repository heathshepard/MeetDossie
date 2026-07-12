// Vercel Serverless Function: /api/cancel-subscription
// Handles subscription cancellation requests
//
// POST (no body required)
//   Authorization: Bearer <supabase user JWT>
//   - Cancels Stripe subscription (cancel_at_period_end)
//   - Updates profiles table (cancellation_requested_at timestamp)
//   - Sends confirmation email via Resend
//   - Notifies Heath via Telegram
//
// Environment:
//   STRIPE_SECRET_KEY            — Stripe secret key
//   RESEND_API_KEY              — Resend API key
//   TELEGRAM_MARKETING_BOT_TOKEN — Telegram bot token
//   TELEGRAM_CHAT_ID             — Heath's Telegram chat ID
//   SUPABASE_URL                 — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY    — service-role JWT

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'POST, OPTIONS' });
}

async function getStripeCustomerAndSubscription(userId) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&status=eq.active&select=stripe_customer_id,stripe_subscription_id&limit=1`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to load subscription: ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  return {
    customerId: data[0].stripe_customer_id,
    subscriptionId: data[0].stripe_subscription_id,
  };
}

async function cancelStripeSubscription(subscriptionId) {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY not configured');
  }

  const response = await fetch(
    `https://api.stripe.com/v1/subscriptions/${subscriptionId}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'cancel_at_period_end=true',
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Stripe cancellation failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function updateProfileCancellation(userId) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        cancellation_requested_at: new Date().toISOString(),
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to update profile: ${response.status}`);
  }
}

async function sendConfirmationEmail(email, endDate) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[cancel-subscription] RESEND_API_KEY not set — skipping confirmation email');
    return;
  }

  const html = `
    <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 32px 20px; color: #1C2B3A; line-height: 1.7;">
      <h2 style="font-family: 'Cormorant Garamond', Georgia, serif; margin: 0 0 12px;">Subscription Cancelled</h2>
      <p>We've cancelled your Dossie subscription as requested.</p>
      <p><strong>Your access continues until:</strong> ${endDate}</p>
      <p>After that date:</p>
      <ul>
        <li>Your account will be locked</li>
        <li>Your data will be retained for 30 days</li>
        <li>You can reactivate anytime within 30 days by emailing heath@meetdossie.com</li>
      </ul>
      <p>If you cancelled by mistake or have any questions, just reply to this email.</p>
      <p style="margin-top: 24px; color: #7A7468; font-size: 14px;">— Heath & the Dossie team</p>
    </div>
  `;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Dossie <dossie@meetdossie.com>',
        to: [email],
        subject: 'Subscription Cancelled — Access Until ' + endDate,
        html,
        bcc: ['heath@meetdossie.com'],
      }),
    });

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      console.error('[cancel-subscription] Resend confirmation failed:', res.status, j);
    }
  } catch (err) {
    console.error('[cancel-subscription] confirmation email threw:', err && err.message);
  }
}

async function notifyHeathOnTelegram(email, userId) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[cancel-subscription] Telegram not configured — skipping Heath notification');
    return;
  }

  const text = `🚨 <b>SUBSCRIPTION CANCELLED</b>\n\n<b>Email:</b> ${email || 'unknown'}\n<b>User ID:</b> ${userId || 'unknown'}\n<b>Time:</b> ${new Date().toISOString()}`;

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
      console.error('[cancel-subscription] Telegram notification failed:', res.status);
    }
  } catch (err) {
    console.error('[cancel-subscription] Telegram threw:', err && err.message);
  }
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(corsAllowed ? 204 : 403).end();
  }
  if (!corsAllowed) {
    return res.status(403).json({ ok: false, error: 'Origin not allowed.' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Server not configured.' });
  }

  let auth;
  try {
    auth = await verifySupabaseToken(req);
  } catch (err) {
    const status = err instanceof AuthError && err.status ? err.status : 401;
    return res.status(status).json({ ok: false, error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  try {
    // Load Stripe customer and subscription from Supabase
    const stripeData = await getStripeCustomerAndSubscription(auth.userId);
    if (!stripeData || !stripeData.subscriptionId) {
      return res.status(404).json({ ok: false, error: 'No active subscription found.' });
    }

    // Cancel Stripe subscription (cancel_at_period_end)
    const cancelledSubscription = await cancelStripeSubscription(stripeData.subscriptionId);
    const endDate = cancelledSubscription.cancel_at
      ? new Date(cancelledSubscription.cancel_at * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : 'the end of your billing period';

    // Update profile with cancellation timestamp
    await updateProfileCancellation(auth.userId);

    // Send confirmation email
    await sendConfirmationEmail(auth.email, endDate);

    // Notify Heath via Telegram
    await notifyHeathOnTelegram(auth.email, auth.userId);

    return res.status(200).json({
      ok: true,
      message: 'Subscription cancelled successfully.',
      endsAt: endDate,
    });
  } catch (err) {
    console.error('[cancel-subscription] error:', err && err.message);
    return res.status(500).json({
      ok: false,
      error: err && err.message || 'Failed to cancel subscription.',
    });
  }
};
