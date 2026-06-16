// Vercel Serverless Function: /api/send-wire-fraud-warning
// Sends a wire fraud prevention email to a buyer and logs the delivery.
//
// POST { transaction_id, buyer_email, buyer_name, property_address, closing_date? }
// Authorization: Bearer <supabase user JWT>
//
// Environment:
//   RESEND_API_KEY            — Resend API key
//   SUPABASE_URL              — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY — service-role JWT

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

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

const isValidEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

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
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  let userId;
  try {
    const auth = await verifySupabaseToken(req);
    userId = auth.userId;
  } catch (err) {
    const status = err instanceof AuthError && err.status ? err.status : 401;
    return res.status(status).json({ ok: false, error: 'Unauthorized' });
  }

  const { transaction_id, buyer_email, buyer_name, property_address, closing_date } = req.body || {};

  if (!transaction_id) {
    return res.status(400).json({ ok: false, error: 'transaction_id is required' });
  }
  if (!isValidEmail(buyer_email)) {
    return res.status(400).json({ ok: false, error: 'A valid buyer_email is required' });
  }
  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ ok: false, error: 'Email service not configured' });
  }

  const trimmedEmail = String(buyer_email).trim();
  const trimmedName = String(buyer_name || 'Buyer').trim();
  const addr = String(property_address || '').trim();
  const closingText = closing_date ? ` before your closing on ${closing_date}` : '';

  const subject = `Wire Fraud Alert — ${addr || 'Your Transaction'}`;
  const body = `Hi ${trimmedName},

IMPORTANT: Wire fraud is a major risk in real estate transactions.

Before your closing${closingText}, you may receive an email with wire instructions. DO NOT TRUST EMAIL FOR WIRING INSTRUCTIONS.

Never wire funds based on email instructions alone. Always:
1. Call your title company directly to verify wire instructions (use a number from their official website, NOT from email)
2. Ask your agent to confirm via phone
3. Use only verified, official wire instructions

Wire fraud is irreversible. Stolen funds cannot be recovered.

If you have any doubt about wire instructions, call your real estate agent or title company immediately.

Stay safe,
Dossie
The Real Estate Agent's AI Assistant`;

  const htmlBody = `<div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #1C2B3A; line-height: 1.7;">
<p>Hi ${trimmedName},</p>

<p><strong style="color: #E8836B;">IMPORTANT: Wire fraud is a major risk in real estate transactions.</strong></p>

<p>Before your closing${closingText}, you may receive an email with wire instructions. <strong>DO NOT TRUST EMAIL FOR WIRING INSTRUCTIONS.</strong></p>

<p>Never wire funds based on email instructions alone. Always:</p>
<ol>
<li>Call your title company directly to verify wire instructions (use a number from their official website, NOT from email)</li>
<li>Ask your agent to confirm via phone</li>
<li>Use only verified, official wire instructions</li>
</ol>

<p><strong>Wire fraud is irreversible. Stolen funds cannot be recovered.</strong></p>

<p>If you have any doubt about wire instructions, call your real estate agent or title company immediately.</p>

<p>Stay safe,<br>
Dossie<br>
The Real Estate Agent's AI Assistant</p>

<div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #E8E0D8; font-size: 12px; color: #9CA8B4; line-height: 1.6;">
If you don't see future emails from Dossie, please check your spam folder and mark dossie@meetdossie.com as a safe sender.
</div>
</div>`;

  const emailPayload = {
    from: 'Dossie <dossie@meetdossie.com>',
    to: [trimmedEmail],
    subject: subject,
    html: htmlBody,
  };

  let emailResult;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(emailPayload),
    });
    emailResult = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('[send-wire-fraud-warning] Resend error:', emailResult);
      return res.status(502).json({ ok: false, error: emailResult.message || 'Email failed to send' });
    }
  } catch (err) {
    console.error('[send-wire-fraud-warning] fetch threw:', err && err.message);
    return res.status(502).json({ ok: false, error: 'Email service unavailable' });
  }

  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/email_queue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          user_id: userId,
          transaction_id: String(transaction_id),
          to_email: trimmedEmail,
          from_name: 'Dossie',
          subject: subject,
          body: body,
          status: 'sent',
          sent_at: new Date().toISOString(),
        }),
      });
    } catch (err) {
      console.warn('[send-wire-fraud-warning] email_queue log failed:', err && err.message);
    }
  }

  return res.status(200).json({ ok: true, emailId: emailResult && emailResult.id });
};
