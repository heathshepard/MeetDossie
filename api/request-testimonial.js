// Vercel Serverless Function: /api/request-testimonial
//
// POST { transaction_id }
// Sends a testimonial/review request reminder to the agent for a specific
// closed deal. Same email as cron-testimonial-request.js but manually
// triggered from inside the app.
//
// Auth: Supabase JWT (Bearer token in Authorization header)

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { customerFirstName } = require('./_lib/personalization.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const FROM_ADDRESS = 'Dossie <dossie@meetdossie.com>';

const BRAND_BG = '#FDFCFA';
const BRAND_NAVY = '#1C2B3A';
const BRAND_TEXT_SOFT = '#5C6B7A';
const BRAND_CORAL = '#E8927C';
const BRAND_MUTED = '#9CA8B4';
const BRAND_SAGE = '#8BA888';

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
  'https://staging.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin) || origin.endsWith('.vercel.app') || origin.endsWith('.meetdossie.com')) {
      allowOrigin = origin;
    }
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin) || !origin;
}

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
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

function buildEmailHtml({ firstName, propertyAddress, googleReviewUrl, zillowReviewUrl }) {
  const name = (firstName || '').trim() || 'there';
  const property = propertyAddress || 'your recently closed property';

  const hasGoogle = Boolean(googleReviewUrl);
  const hasZillow = Boolean(zillowReviewUrl);
  const hasAnyLinks = hasGoogle || hasZillow;

  const googleBlock = hasGoogle
    ? `<a href="${googleReviewUrl}" style="display: inline-block; margin: 6px 8px 6px 0; padding: 10px 20px; background: ${BRAND_CORAL}; color: white; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 14px;">Leave a Google Review</a>`
    : '';

  const zillowBlock = hasZillow
    ? `<a href="${zillowReviewUrl}" style="display: inline-block; margin: 6px 8px 6px 0; padding: 10px 20px; background: ${BRAND_NAVY}; color: white; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 14px;">Leave a Zillow Review</a>`
    : '';

  const reviewLinksSection = hasAnyLinks
    ? `<div style="margin: 0 0 28px;">
    <div style="font-size: 12px; font-weight: 700; letter-spacing: 1px; color: ${BRAND_MUTED}; text-transform: uppercase; margin-bottom: 12px;">Your review links</div>
    ${hasGoogle ? `<div>${googleBlock}</div>` : ''}
    ${hasZillow ? `<div style="margin-top: 8px;">${zillowBlock}</div>` : ''}
  </div>`
    : `<div style="margin: 0 0 28px; padding: 14px 18px; background: #F5F0EA; border-radius: 8px;">
    <p style="font-size: 14px; color: ${BRAND_TEXT_SOFT}; margin: 0;">Add your Google and Zillow review links in <a href="https://meetdossie.com/app" style="color: ${BRAND_CORAL};">Settings</a> so Dossie can include them automatically next time.</p>
  </div>`;

  const reviewLinksInCopy = [
    hasGoogle ? `Google: ${googleReviewUrl}` : '',
    hasZillow ? `Zillow: ${zillowReviewUrl}` : '',
  ].filter(Boolean).join('\n');

  const suggestedCopy = `Hi [Client name],

It was such a pleasure working with you on ${property}. I hope you're settling in and loving the new place.

If you have a moment, I'd be grateful if you could leave a quick review - it means everything to small businesses like mine and helps other buyers/sellers find someone they can trust.
${reviewLinksInCopy ? '\n' + reviewLinksInCopy + '\n' : ''}
Thank you so much - it was truly a joy to work with you.

[Your name]`;

  const reviewSubheading = hasAnyLinks
    ? `Your review links are pre-populated below.`
    : `Once you add your review links in Settings, Dossie will include them automatically.`;

  return `<div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 24px; background: ${BRAND_BG}; color: ${BRAND_NAVY};">
  <div style="font-size: 12px; letter-spacing: 2px; color: ${BRAND_CORAL}; text-transform: uppercase; font-weight: 700; margin-bottom: 18px;">DOSSIE &middot; REVIEW REQUEST</div>
  <h1 style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 32px; line-height: 1.2; margin: 0 0 22px; color: ${BRAND_NAVY};">Hi ${name},</h1>
  <p style="font-size: 17px; color: ${BRAND_NAVY}; line-height: 1.6; margin: 0 0 10px;">Here is your review request for <strong>${property}</strong>. Forward the message below to your client while the experience is still fresh.</p>
  <p style="font-size: 15px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 0 0 28px;">${reviewSubheading}</p>

  ${reviewLinksSection}

  <div style="background: #F5F0EA; border-radius: 12px; padding: 20px 22px; margin: 0 0 28px;">
    <div style="font-size: 12px; font-weight: 700; letter-spacing: 1px; color: ${BRAND_MUTED}; text-transform: uppercase; margin-bottom: 12px;">Suggested message to forward</div>
    <pre style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; font-size: 14px; color: ${BRAND_NAVY}; line-height: 1.7; white-space: pre-wrap; margin: 0;">${suggestedCopy}</pre>
  </div>

  <a href="https://meetdossie.com/app" style="display: inline-block; padding: 16px 32px; background: ${BRAND_SAGE}; color: white; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 15px; letter-spacing: 0.2px;">Open Dossie</a>

  <p style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 20px; color: ${BRAND_NAVY}; line-height: 1.4; margin: 28px 0 4px;">- Dossie</p>
  <p style="margin-top: 36px; font-size: 12px; color: ${BRAND_MUTED}; line-height: 1.6;">To add or update your review links, go to Settings inside Dossie.</p>
</div>`;
}

async function sendResend(to, subject, html) {
  // No BCC: customer-file operational email per feedback_bcc_heath_on_all_emails.md
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: r.ok, status: r.status, data, raw: text };
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') {
    return res.status(corsAllowed ? 204 : 403).end();
  }
  if (!corsAllowed) {
    return res.status(403).json({ ok: false, error: 'Origin not allowed.' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured.' });
  }

  let userId, userEmail;
  try {
    const auth = await verifySupabaseToken(req);
    userId = auth.userId;
    userEmail = auth.email;
  } catch (err) {
    const status = err instanceof AuthError && err.status ? err.status : 401;
    return res.status(status).json({ ok: false, error: 'Unauthorized' });
  }

  const body = req.body || {};
  const { transaction_id } = body;
  if (!transaction_id) {
    return res.status(400).json({ ok: false, error: 'transaction_id required' });
  }

  // Fetch the transaction — enforce user ownership.
  const txResp = await supabaseFetch(
    `/rest/v1/transactions?id=eq.${encodeURIComponent(transaction_id)}&user_id=eq.${encodeURIComponent(userId)}&select=id,user_id,property_address,status`,
  );
  if (!txResp.ok || !txResp.data || txResp.data.length === 0) {
    return res.status(404).json({ ok: false, error: 'Transaction not found.' });
  }
  const tx = txResp.data[0];

  // Fetch the agent's profile for name and review links.
  const profResp = await supabaseFetch(
    `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=full_name,preferred_name,email,google_review_url,zillow_review_url`,
  );
  const profile = profResp.ok && profResp.data && profResp.data.length > 0 ? profResp.data[0] : null;

  // Resolve email: profile.email → JWT email → auth.users fallback.
  let toEmail = (profile && profile.email) || userEmail || null;
  if (!toEmail) {
    const authUserResp = await supabaseFetch(
      `/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    );
    toEmail = (authUserResp.ok && authUserResp.data && authUserResp.data.email) || null;
  }
  if (!toEmail) {
    return res.status(400).json({ ok: false, error: 'No email address on file for this agent.' });
  }

  if (!RESEND_API_KEY) {
    return res.status(503).json({ ok: false, error: 'Email service not configured.' });
  }

  // preferred_name wins over full_name's first token so the agent gets
  // greeted by what they actually go by (e.g. Suzanne, not Kay).
  const firstNameRaw = customerFirstName(profile || { email: toEmail });
  const firstName = firstNameRaw.charAt(0).toUpperCase() + firstNameRaw.slice(1);
  const subject = `Review request ready for ${tx.property_address || 'your closed deal'}`;
  const html = buildEmailHtml({
    firstName,
    propertyAddress: tx.property_address,
    googleReviewUrl: profile && profile.google_review_url ? profile.google_review_url : null,
    zillowReviewUrl: profile && profile.zillow_review_url ? profile.zillow_review_url : null,
  });

  const send = await sendResend(toEmail, subject, html);
  if (!send.ok) {
    console.error('[request-testimonial] resend failed', toEmail, send.status, (send.raw || '').slice(0, 200));
    return res.status(502).json({ ok: false, error: 'Email failed to send. Try again shortly.' });
  }

  // Stamp the transaction so the UI reflects the sent state.
  await supabaseFetch(
    `/rest/v1/transactions?id=eq.${encodeURIComponent(tx.id)}&user_id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ testimonial_requested_at: new Date().toISOString() }),
    },
  );

  return res.status(200).json({ ok: true });
};
