// Vercel Serverless Function: /api/support
// Handles support ticket submissions from the in-app feedback modal.
//
// POST { ticketType, message, userId, agentEmail }
//   Authorization: Bearer <supabase user JWT>
//   - Inserts a row into public.support_tickets
//   - Notifies Heath via Resend
//
// GET (admin only — heath.shepard@kw.com)
//   Authorization: Bearer <supabase user JWT>
//   - Returns { tickets: [...] } ordered newest first
//
// Environment:
//   RESEND_API_KEY            — Resend API key
//   SUPABASE_URL              — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY — service-role JWT (server-side only)

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const ADMIN_EMAIL = 'heath.shepard@kw.com';
const SUPPORT_NOTIFICATION_TO = 'heath.shepard@kw.com';

const ALLOWED_TICKET_TYPES = new Set(['bug', 'feature', 'help', 'other']);

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
  return Boolean(allowOrigin) || !origin;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function insertTicket(row) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/support_tickets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`support_tickets insert failed (${response.status}): ${text}`);
  }
  const json = await response.json().catch(() => null);
  return Array.isArray(json) ? json[0] : json;
}

async function listTickets() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/support_tickets?select=*&order=created_at.desc`,
    {
      method: 'GET',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`support_tickets list failed (${response.status}): ${text}`);
  }
  return response.json();
}

async function notifyHeath({ ticketType, message, agentEmail, ticketId }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[support] RESEND_API_KEY not set — skipping notification email');
    return;
  }
  const subjectType = ticketType.charAt(0).toUpperCase() + ticketType.slice(1);
  const html = `
    <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 32px 20px; color: #1C2B3A; line-height: 1.7;">
      <h2 style="font-family: 'Cormorant Garamond', Georgia, serif; margin: 0 0 12px;">New Dossie support ticket</h2>
      <p style="margin: 0 0 6px;"><strong>Type:</strong> ${escapeHtml(ticketType)}</p>
      <p style="margin: 0 0 6px;"><strong>From:</strong> ${escapeHtml(agentEmail || '(unknown)')}</p>
      <p style="margin: 0 0 16px;"><strong>Ticket ID:</strong> ${escapeHtml(ticketId || '')}</p>
      <div style="padding: 16px; background: #F7F2EA; border-radius: 8px; white-space: pre-wrap;">${escapeHtml(message)}</div>
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
        from: 'Dossie Support <dossie@meetdossie.com>',
        to: [SUPPORT_NOTIFICATION_TO],
        reply_to: agentEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(agentEmail) ? agentEmail : undefined,
        subject: `[Dossie ${subjectType}] from ${agentEmail || 'unknown'}`,
        html,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      console.error('[support] Resend notify failed:', res.status, j);
    }
  } catch (err) {
    console.error('[support] notify threw:', err && err.message);
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

  if (req.method === 'GET') {
    if (!auth.email || String(auth.email).toLowerCase() !== ADMIN_EMAIL) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    try {
      const tickets = await listTickets();
      return res.status(200).json({ ok: true, tickets });
    } catch (err) {
      console.error('[support] list error:', err && err.message);
      return res.status(500).json({ ok: false, error: 'Could not load tickets.' });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  const { ticketType, message, agentEmail } = req.body || {};
  const cleanType = String(ticketType || '').trim().toLowerCase();
  if (!ALLOWED_TICKET_TYPES.has(cleanType)) {
    return res.status(400).json({ ok: false, error: 'Invalid ticket type.' });
  }
  const cleanMessage = String(message || '').trim();
  if (cleanMessage.length < 20) {
    return res.status(400).json({ ok: false, error: 'Message must be at least 20 characters.' });
  }
  if (cleanMessage.length > 5000) {
    return res.status(400).json({ ok: false, error: 'Message is too long.' });
  }

  const cleanAgentEmail = typeof agentEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(agentEmail.trim())
    ? agentEmail.trim().toLowerCase()
    : (auth.email || null);

  let ticket;
  try {
    ticket = await insertTicket({
      user_id: auth.userId,
      agent_email: cleanAgentEmail,
      ticket_type: cleanType,
      message: cleanMessage,
      status: 'open',
    });
  } catch (err) {
    console.error('[support] insert error:', err && err.message);
    return res.status(500).json({ ok: false, error: 'Could not save ticket.' });
  }

  await notifyHeath({
    ticketType: cleanType,
    message: cleanMessage,
    agentEmail: cleanAgentEmail,
    ticketId: ticket && ticket.id,
  });

  return res.status(200).json({ ok: true, ticketId: ticket && ticket.id });
};
