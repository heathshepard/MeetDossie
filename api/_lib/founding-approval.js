// Shared logic for the founding-application approve/reject lifecycle.
// Called from BOTH /api/admin-approve-founding (Bearer-CRON_SECRET, used for
// programmatic / one-shot triggers) and /api/telegram-webhook (Heath taps an
// inline button on the application notification). Keeping the body in one
// place means the email + Stripe + DB updates can never drift between the
// two entry points.

const Stripe = require('stripe');

const FOUNDING_PRICE_ID = 'price_1TPxxNL920SKTEEiN7Gphq8T';
const FOUNDING_COUPON_ID = 'FOUNDING'; // Stripe coupon (best-effort; fallback skips it if not found)
const SUCCESS_URL = 'https://meetdossie.com/welcome.html?session_id={CHECKOUT_SESSION_ID}';
const CANCEL_URL = 'https://meetdossie.com/founding.html';

async function supabaseGet(path) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`supabase GET ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function supabasePatch(path, patch) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`supabase PATCH ${r.status}: ${t.slice(0, 200)}`);
  }
}

async function loadApplication(applicationId) {
  const enc = encodeURIComponent(applicationId);
  const rows = await supabaseGet(
    `/rest/v1/founding_applications?id=eq.${enc}&select=*&limit=1`,
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

async function createFoundingCheckout(stripeKey, email) {
  const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });
  // Strict mode: FOUNDING coupon must apply. We don't fall back to
  // allow_promotion_codes — if the coupon isn't valid in Stripe, surface
  // the error so the operator notices instead of quietly mailing a session
  // that wouldn't honor the founding price lock.
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: FOUNDING_PRICE_ID, quantity: 1 }],
    success_url: SUCCESS_URL,
    cancel_url: CANCEL_URL,
    discounts: [{ coupon: FOUNDING_COUPON_ID }],
    billing_address_collection: 'auto',
    customer_email: email,
    metadata: { source: 'founding_approval' },
    subscription_data: { metadata: { source: 'founding_approval' } },
  });
  return { session, couponApplied: true };
}

function approvalEmailHtml({ firstName, checkoutUrl }) {
  const safeName = String(firstName || 'there').replace(/[<>]/g, '');
  const safeUrl = String(checkoutUrl).replace(/[<>"]/g, '');
  return `
<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#FDFCFA;font-family:'Plus Jakarta Sans',Arial,sans-serif;color:#1A1A2E;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
    <p style="font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;line-height:1.3;margin:0 0 24px;">${safeName},</p>
    <p style="font-size:16px;line-height:1.6;margin:0 0 18px;">You're in. I read your application and it's exactly the kind of agent Dossie was built for.</p>
    <p style="font-size:16px;line-height:1.6;margin:0 0 18px;">As a founding member you're locked in at <strong>$29/month for life</strong>. That price never goes up, even when we raise it for everyone else later this year.</p>
    <p style="font-size:16px;line-height:1.6;margin:0 0 28px;">Tap below to claim your spot. Takes about a minute.</p>
    <p style="text-align:center;margin:0 0 32px;">
      <a href="${safeUrl}" style="display:inline-block;background:#E8836B;color:#FFFFFF;text-decoration:none;font-weight:600;font-size:16px;padding:14px 32px;border-radius:10px;">Claim my founding spot</a>
    </p>
    <p style="font-size:14px;line-height:1.6;color:#7A7468;margin:0 0 6px;">Or paste this link into your browser:</p>
    <p style="font-size:13px;line-height:1.5;color:#7A7468;margin:0 0 32px;word-break:break-all;"><a href="${safeUrl}" style="color:#7A7468;">${safeUrl}</a></p>
    <p style="font-size:16px;line-height:1.6;margin:0 0 6px;">Reply to this email if anything sticks. I read every one.</p>
    <p style="font-family:'Cormorant Garamond',Georgia,serif;font-size:20px;line-height:1.4;margin:24px 0 0;">— Heath, founder of Dossie</p>
  </div>
</body>
</html>`.trim();
}

async function sendApprovalEmail({ resendKey, email, name, checkoutUrl, heardFrom }) {
  if (!resendKey) throw new Error('RESEND_API_KEY missing');
  const firstName = String(name || '').trim().split(/\s+/)[0] || '';
  const html = approvalEmailHtml({ firstName, checkoutUrl });
  const heardSlug = String(heardFrom || 'unknown').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64) || 'unknown';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Heath at Dossie <heath@meetdossie.com>',
      to: [email],
      reply_to: 'heath@meetdossie.com',
      subject: "You're in — claim your Dossie founding spot",
      html,
      // Tags surface in the Resend dashboard so Heath can slice approval-email
      // sends by acquisition channel without joining back to the DB.
      tags: [
        { name: 'category', value: 'founding_approval' },
        { name: 'heard_from', value: heardSlug },
      ],
      headers: {
        'X-Heard-From': heardSlug,
      },
    }),
  });
  const text = await r.text().catch(() => '');
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!r.ok) {
    throw new Error(`Resend ${r.status}: ${text.slice(0, 300)}`);
  }
  return parsed;
}

const HEARD_FROM_LABELS = {
  facebook_group: 'Facebook group post',
  facebook_page: 'Facebook page',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  twitter_x: 'Twitter/X',
  google_search: 'Google search',
  word_of_mouth: 'Word of mouth / another agent',
  trec_calculator: 'TREC deadline calculator',
  linkedin: 'LinkedIn',
  other: 'Other',
};

function prettyHeardFrom(v) {
  if (!v) return '—';
  return HEARD_FROM_LABELS[String(v).toLowerCase()] || String(v);
}

async function sendHeathTelegramConfirmation({ botToken, chatId, app, checkoutUrl, couponApplied, emailId }) {
  if (!botToken || !chatId) return;
  const text = [
    '✅ <b>Founding approval sent</b>',
    '',
    `<b>Name:</b> ${app.name}`,
    `<b>Email:</b> ${app.email}`,
    `<b>How they found us:</b> ${prettyHeardFrom(app.heard_from)}`,
    `<b>Checkout URL:</b> ${checkoutUrl}`,
    `<b>FOUNDING coupon:</b> ${couponApplied ? 'pre-applied' : 'NOT pre-applied — they can type it at checkout'}`,
    `<b>Resend message id:</b> ${emailId || '—'}`,
  ].join('\n');
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
}

// Top-level entry point. Idempotent — safe to call twice on the same row;
// the second call refreshes the checkout URL and re-sends the email.
async function approveFoundingApplication({ applicationId, env }) {
  const app = await loadApplication(applicationId);
  if (!app) {
    return { ok: false, error: `application ${applicationId} not found` };
  }

  // Update status (no-op if already approved).
  const now = new Date().toISOString();
  await supabasePatch(
    `/rest/v1/founding_applications?id=eq.${encodeURIComponent(applicationId)}`,
    { status: 'approved', decision: 'approved', reviewed_at: now },
  );

  if (!env.STRIPE_SECRET_KEY) {
    return { ok: false, error: 'STRIPE_SECRET_KEY not configured' };
  }
  const { session, couponApplied } = await createFoundingCheckout(env.STRIPE_SECRET_KEY, app.email);
  if (!session || !session.url) {
    return { ok: false, error: 'Stripe returned no session url' };
  }

  let emailId = null;
  let emailError = null;
  try {
    const emailResp = await sendApprovalEmail({
      resendKey: env.RESEND_API_KEY,
      email: app.email,
      name: app.name,
      checkoutUrl: session.url,
      heardFrom: app.heard_from,
    });
    emailId = emailResp?.id || null;
  } catch (err) {
    emailError = (err && err.message) || String(err);
    console.error('[founding-approval] email failed:', emailError);
  }

  await sendHeathTelegramConfirmation({
    botToken: env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_MARKETING_BOT_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
    app,
    checkoutUrl: session.url,
    couponApplied,
    emailId,
  });

  return {
    ok: true,
    application: { id: app.id, name: app.name, email: app.email },
    checkoutUrl: session.url,
    couponApplied,
    emailId,
    emailError,
  };
}

async function rejectFoundingApplication({ applicationId }) {
  const app = await loadApplication(applicationId);
  if (!app) {
    return { ok: false, error: `application ${applicationId} not found` };
  }
  const now = new Date().toISOString();
  await supabasePatch(
    `/rest/v1/founding_applications?id=eq.${encodeURIComponent(applicationId)}`,
    { status: 'rejected', decision: 'rejected', reviewed_at: now },
  );
  return { ok: true, application: { id: app.id, name: app.name, email: app.email } };
}

module.exports = {
  approveFoundingApplication,
  rejectFoundingApplication,
  FOUNDING_PRICE_ID,
  FOUNDING_COUPON_ID,
};
