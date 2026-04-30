// Vercel Serverless Function: /api/support
// POST: create a new support ticket. Auth required.
// GET:  list tickets — admin only (heath.shepard@kw.com).

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL = 'heath.shepard@kw.com';
const TICKET_TYPES = new Set(['bug', 'feature', 'help']);

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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin);
}

async function supabaseRest(path, init) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...((init && init.headers) || {}),
  };
  return fetch(url, { ...init, headers });
}

async function maybeNotifyResend(ticketType, agentEmail, message) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    const safeMessage = String(message).replace(/[<>&]/g, (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])
    ).replace(/\n/g, '<br>');
    const safeEmail = String(agentEmail || 'unknown').replace(/[<>&]/g, '');
    const safeType = String(ticketType).replace(/[^a-z]/gi, '');
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Dossie Support <support@meetdossie.com>',
        to: ADMIN_EMAIL,
        subject: `[${safeType.toUpperCase()}] New Dossie support ticket`,
        html: `
          <h2>New ${safeType} ticket</h2>
          <p><strong>From:</strong> ${safeEmail}</p>
          <p><strong>Type:</strong> ${safeType}</p>
          <p><strong>Message:</strong></p>
          <p>${safeMessage}</p>
          <p><small>Submitted at ${new Date().toISOString()}</small></p>
        `,
      }),
    });
  } catch (err) {
    console.error('[support] Resend notify failed:', err && err.message ? err.message : err);
  }
}

module.exports = async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[support] Supabase not configured.');
    res.status(500).json({ ok: false, error: 'Support is not configured.' });
    return;
  }

  try {
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'support', 30, 60 * 60 * 1000);

    const { userId, email } = await verifySupabaseToken(req);

    if (req.method === 'POST') {
      const body = req.body || {};
      const ticketType = sanitizeString(body.ticketType || '', { maxLength: 16 }).toLowerCase();
      const message = sanitizeString(body.message || '', { maxLength: 4000 });
      const agentEmail = sanitizeString(body.agentEmail || email || '', { maxLength: 200 });

      if (!TICKET_TYPES.has(ticketType)) {
        throw new ValidationError('ticketType must be one of: bug, feature, help.');
      }
      if (!message || message.trim().length < 20) {
        throw new ValidationError('Message must be at least 20 characters.');
      }

      const insertResp = await supabaseRest('support_tickets', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify([{
          user_id: userId,
          agent_email: agentEmail || null,
          ticket_type: ticketType,
          message,
          status: 'open',
        }]),
      });
      if (!insertResp.ok) {
        const text = await insertResp.text().catch(() => '');
        throw new Error(`ticket insert failed (${insertResp.status}): ${text.slice(0, 200)}`);
      }
      const rows = await insertResp.json().catch(() => []);
      const inserted = Array.isArray(rows) && rows.length ? rows[0] : null;

      // Fire-and-forget email; don't block the response on Resend.
      void maybeNotifyResend(ticketType, agentEmail, message);

      return res.status(200).json({ ok: true, ticketId: inserted ? inserted.id : null });
    }

    if (req.method === 'GET') {
      // Admin-only: only the configured admin email may list tickets.
      if (!email || email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
        return res.status(403).json({ ok: false, error: 'Admin access required.' });
      }
      const listResp = await supabaseRest(
        'support_tickets?select=*&order=created_at.desc',
        { method: 'GET' },
      );
      if (!listResp.ok) {
        const text = await listResp.text().catch(() => '');
        throw new Error(`tickets list failed (${listResp.status}): ${text.slice(0, 200)}`);
      }
      const rows = await listResp.json().catch(() => []);
      return res.status(200).json({ ok: true, tickets: Array.isArray(rows) ? rows : [] });
    }

    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof ValidationError) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }
    if (error instanceof RateLimitError) {
      if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' });
    }
    console.error('[support] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not submit ticket.' });
  }
};
