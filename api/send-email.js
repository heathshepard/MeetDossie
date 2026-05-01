// Vercel Serverless Function: /api/send-email
// Sends an email via Resend on behalf of the agent and (optionally) logs the
// send to the `email_queue` table.
//
// POST { to, subject, body, agentName?, agentEmail?, transactionId?, replyTo? }
// Authorization: Bearer <supabase user JWT>
//
// Environment:
//   RESEND_API_KEY            — Resend API key
//   SUPABASE_URL              — Supabase project URL (for email_queue logging)
//   SUPABASE_SERVICE_ROLE_KEY — service-role JWT (for email_queue logging)

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  // Same-origin requests have no Origin header — let them through.
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

  const { to, subject, body, agentName, agentEmail, transactionId, replyTo } = req.body || {};

  if (!isValidEmail(to)) {
    return res.status(400).json({ ok: false, error: 'A valid recipient email is required.' });
  }
  if (typeof subject !== 'string' || !subject.trim()) {
    return res.status(400).json({ ok: false, error: 'subject is required' });
  }
  if (typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ ok: false, error: 'body is required' });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ ok: false, error: 'Email service not configured' });
  }

  const trimmedTo = String(to).trim();
  const trimmedSubject = String(subject).trim();
  const trimmedBody = String(body);

  const cleanAgentName = typeof agentName === 'string' ? agentName.trim() : '';
  const fromName = cleanAgentName ? `${cleanAgentName} via Dossie` : 'Dossie';

  // Escape body before injecting to avoid injecting raw HTML from a model.
  const escaped = trimmedBody
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const htmlBody = `<div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #1C2B3A; line-height: 1.7;">${escaped.replace(/\n/g, '<br>')}</div>`;

  const emailPayload = {
    from: `${fromName} <dossie@meetdossie.com>`,
    to: [trimmedTo],
    subject: trimmedSubject,
    html: htmlBody,
  };

  const replyToCandidate = (typeof replyTo === 'string' && replyTo) || (typeof agentEmail === 'string' && agentEmail) || '';
  if (isValidEmail(replyToCandidate)) {
    emailPayload.reply_to = replyToCandidate.trim();
  }

  let result;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(emailPayload),
    });
    result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('[send-email] Resend error:', result);
      return res.status(502).json({ ok: false, error: result.message || 'Email failed to send' });
    }
  } catch (err) {
    console.error('[send-email] fetch threw:', err && err.message);
    return res.status(502).json({ ok: false, error: 'Email service unavailable' });
  }

  if (transactionId) {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/email_queue`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            user_id: userId,
            transaction_id: String(transactionId),
            to_email: trimmedTo,
            from_name: fromName,
            subject: trimmedSubject,
            body: trimmedBody,
            status: 'sent',
            sent_at: new Date().toISOString(),
          }),
        });
      } catch (err) {
        console.warn('[send-email] email_queue log failed:', err && err.message);
      }
    }
  }

  return res.status(200).json({ ok: true, emailId: result && result.id });
};
