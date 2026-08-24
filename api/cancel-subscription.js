// Vercel Serverless Function: /api/cancel-subscription
// Handles subscription cancellation requests
//
// POST
//   Authorization: Bearer <supabase user JWT>
//   body (all optional — exit survey, never blocks cancellation):
//     { reason?: string, reasonDetail?: string, whatWouldHaveKeptThem?: string }
//   - Persists the exit-survey answers to cancellation_feedback FIRST (see
//     supabase/migrations/20260824190000_cancellation_feedback.sql /
//     admin-migrate-cancellation-feedback.js) — one row per attempt, even if
//     the Stripe cancellation below fails, so a customer's typed feedback is
//     never lost to a billing-side error.
//   - Cancels Stripe subscription (cancel_at_period_end)
//   - Updates profiles table (cancellation_requested_at timestamp)
//   - Sends confirmation email via Resend
//   - Notifies Heath via Telegram, including the survey answers (2026-08-24 —
//     Heath's request: this flow is likely the only feedback channel he'll
//     ever get from some cancelling customers)
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
const { escapeHtml } = require('./_lib/outbound-email-send');

// Fixed option set offered in the Settings UI — kept here as the source of
// truth for validation, but reason/reasonDetail are stored as free text
// regardless (defensive — never reject a cancellation over survey shape).
const REASON_OPTIONS = [
  'too_expensive',
  'missing_feature',
  'switched_tool',
  'not_using_enough',
  'technical_issues',
  'other',
];

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

// Persists the exit-survey answers regardless of whether the Stripe
// cancellation below succeeds. `subscriptionCancelled` is set true by the
// caller once Stripe confirms it — never blocks or throws on its own
// failure (a broken survey write must never break the actual cancellation).
async function saveCancellationFeedback({ userId, email, reason, reasonDetail, whatWouldHaveKeptThem, subscriptionCancelled }) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const hasAnySurveyContent = !!(reason || reasonDetail || whatWouldHaveKeptThem);
  if (!hasAnySurveyContent) return null;

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/cancellation_feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        user_id: userId,
        email: email || null,
        reason: reason ? String(reason).slice(0, 200) : null,
        reason_detail: reasonDetail ? String(reasonDetail).slice(0, 2000) : null,
        what_would_have_kept_them: whatWouldHaveKeptThem ? String(whatWouldHaveKeptThem).slice(0, 2000) : null,
        subscription_cancelled: !!subscriptionCancelled,
      }),
    });
    if (!res.ok) {
      console.error('[cancel-subscription] cancellation_feedback insert failed:', res.status, await res.text().catch(() => ''));
      return null;
    }
    const rows = await res.json().catch(() => null);
    return Array.isArray(rows) ? rows[0] : null;
  } catch (err) {
    console.error('[cancel-subscription] cancellation_feedback insert threw:', err && err.message);
    return null;
  }
}

const REASON_LABELS = {
  too_expensive: 'Too expensive',
  missing_feature: 'Missing a feature I need',
  switched_tool: 'Switched to another tool',
  not_using_enough: 'Not using it enough',
  technical_issues: 'Technical issues',
  other: 'Other',
};

// Pure — no network, no env reads — so it can be exercised in a test/script
// without ever touching the real Telegram API or Heath's real chat.
function buildCancellationTelegramMessage(email, userId, survey) {
  let text = `🚨 <b>SUBSCRIPTION CANCELLED</b>\n\n<b>Email:</b> ${escapeHtml(email || 'unknown')}\n<b>User ID:</b> ${escapeHtml(userId || 'unknown')}\n<b>Time:</b> ${new Date().toISOString()}`;

  if (survey && (survey.reason || survey.reasonDetail || survey.whatWouldHaveKeptThem)) {
    const reasonLabel = survey.reason ? (REASON_LABELS[survey.reason] || survey.reason) : null;
    text += `\n\n<b>Exit survey:</b>`;
    text += `\n<b>Reason:</b> ${escapeHtml(reasonLabel || 'not given')}`;
    if (survey.reasonDetail) text += `\n<b>Detail:</b> ${escapeHtml(survey.reasonDetail)}`;
    text += `\n<b>What would have kept them:</b> ${escapeHtml(survey.whatWouldHaveKeptThem || 'not given')}`;
  } else {
    text += `\n\n<i>No exit survey answers given.</i>`;
  }

  return text;
}

async function notifyHeathOnTelegram(email, userId, survey) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[cancel-subscription] Telegram not configured — skipping Heath notification');
    return;
  }

  const text = buildCancellationTelegramMessage(email, userId, survey);

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

  // Exit-survey answers — all optional, never gate the cancellation itself.
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const survey = {
    reason: body.reason && REASON_OPTIONS.includes(body.reason) ? body.reason : (body.reason ? String(body.reason).slice(0, 200) : null),
    reasonDetail: body.reasonDetail ? String(body.reasonDetail).slice(0, 2000) : null,
    whatWouldHaveKeptThem: body.whatWouldHaveKeptThem ? String(body.whatWouldHaveKeptThem).slice(0, 2000) : null,
  };

  try {
    // Load Stripe customer and subscription from Supabase
    const stripeData = await getStripeCustomerAndSubscription(auth.userId);
    if (!stripeData || !stripeData.subscriptionId) {
      // Still capture any survey answers the customer already typed — a
      // lookup miss shouldn't cost them the feedback.
      await saveCancellationFeedback({ userId: auth.userId, email: auth.email, ...survey, subscriptionCancelled: false });
      return res.status(404).json({ ok: false, error: 'No active subscription found.' });
    }

    // Cancel Stripe subscription (cancel_at_period_end)
    const cancelledSubscription = await cancelStripeSubscription(stripeData.subscriptionId);
    const endDate = cancelledSubscription.cancel_at
      ? new Date(cancelledSubscription.cancel_at * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : 'the end of your billing period';

    // Persist the exit survey now that the cancellation actually succeeded
    await saveCancellationFeedback({ userId: auth.userId, email: auth.email, ...survey, subscriptionCancelled: true });

    // Update profile with cancellation timestamp
    await updateProfileCancellation(auth.userId);

    // Send confirmation email
    await sendConfirmationEmail(auth.email, endDate);

    // Notify Heath via Telegram, including the survey answers
    await notifyHeathOnTelegram(auth.email, auth.userId, survey);

    return res.status(200).json({
      ok: true,
      message: 'Subscription cancelled successfully.',
      endsAt: endDate,
    });
  } catch (err) {
    console.error('[cancel-subscription] error:', err && err.message);
    // Best-effort — a customer's typed feedback shouldn't be lost just
    // because the Stripe call itself blew up.
    await saveCancellationFeedback({ userId: auth.userId, email: auth.email, ...survey, subscriptionCancelled: false }).catch(() => {});
    return res.status(500).json({
      ok: false,
      error: err && err.message || 'Failed to cancel subscription.',
    });
  }
};

module.exports.buildCancellationTelegramMessage = buildCancellationTelegramMessage;
