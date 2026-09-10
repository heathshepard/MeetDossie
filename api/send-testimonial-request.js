// Vercel Serverless Function: /api/send-testimonial-request
//
// POST { action_item_id }
//
// The ONLY path that actually sends a drafted testimonial/review request to
// a client. The agent taps Send from inside the app -- never auto-sent (see
// cron-request-testimonial-draft.js, which only ever writes a draft).
//
// Loads the action_items row (ownership enforced via the caller's own
// user_id -- multi-tenant safe), sends the linked email_queue draft
// verbatim via Resend, marks the email_queue row 'sent' and the action item
// 'completed'. Idempotent: calling again on an already-completed item is a
// no-op 200, not a second send.
//
// Auth: Supabase JWT (Bearer token in Authorization header)

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

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

async function sendResend(to, subject, html) {
  // No BCC: customer-file operational email per feedback_bcc_heath_on_all_emails.md
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Dossie <dossie@meetdossie.com>', to: [to], subject, html }),
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: r.ok, status: r.status, data, raw: text };
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ ok: false, error: 'Origin not allowed.' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured.' });
  }

  let userId;
  try {
    const auth = await verifySupabaseToken(req);
    userId = auth.userId;
  } catch (err) {
    const status = err instanceof AuthError && err.status ? err.status : 401;
    return res.status(status).json({ ok: false, error: 'Unauthorized' });
  }

  const { action_item_id } = req.body || {};
  if (!action_item_id) {
    return res.status(400).json({ ok: false, error: 'action_item_id required' });
  }

  // Ownership enforced in the filter itself -- multi-tenant safe.
  const itemResp = await supabaseFetch(
    `/rest/v1/action_items?id=eq.${encodeURIComponent(action_item_id)}&user_id=eq.${encodeURIComponent(userId)}` +
    `&select=id,user_id,transaction_id,action_type,status,email_queue_id&limit=1`,
  );
  if (!itemResp.ok || !Array.isArray(itemResp.data) || itemResp.data.length === 0) {
    return res.status(404).json({ ok: false, error: 'Action item not found.' });
  }
  const item = itemResp.data[0];

  if (item.action_type !== 'testimonial_request') {
    return res.status(400).json({ ok: false, error: 'Not a testimonial request action item.' });
  }
  if (item.status === 'completed') {
    return res.status(200).json({ ok: true, already_sent: true });
  }
  if (!item.email_queue_id) {
    return res.status(400).json({ ok: false, error: 'No draft on file for this action item -- add the client email and try again.' });
  }

  const eqResp = await supabaseFetch(
    `/rest/v1/email_queue?id=eq.${encodeURIComponent(item.email_queue_id)}&user_id=eq.${encodeURIComponent(userId)}` +
    `&select=id,to_email,subject,body,status&limit=1`,
  );
  if (!eqResp.ok || !Array.isArray(eqResp.data) || eqResp.data.length === 0) {
    return res.status(404).json({ ok: false, error: 'Draft email not found.' });
  }
  const draft = eqResp.data[0];

  if (draft.status === 'sent') {
    // Draft already went out (e.g. a retried request) -- reconcile the
    // action item and report success rather than double-sending.
    await supabaseFetch(`/rest/v1/action_items?id=eq.${encodeURIComponent(item.id)}&user_id=eq.${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'completed', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    });
    return res.status(200).json({ ok: true, already_sent: true });
  }

  if (!RESEND_API_KEY) {
    return res.status(503).json({ ok: false, error: 'Email service not configured.' });
  }

  const bodyHtml = String(draft.body || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  const html = `<div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #1C2B3A; line-height: 1.7;">${bodyHtml}</div>`;

  const sent = await sendResend(draft.to_email, draft.subject, html);
  if (!sent.ok) {
    console.error('[send-testimonial-request] resend failed', draft.to_email, sent.status, (sent.raw || '').slice(0, 200));
    return res.status(502).json({ ok: false, error: 'Email failed to send. Try again shortly.' });
  }

  const now = new Date().toISOString();
  await Promise.all([
    supabaseFetch(`/rest/v1/email_queue?id=eq.${encodeURIComponent(draft.id)}&user_id=eq.${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'sent', sent_at: now }),
    }),
    supabaseFetch(`/rest/v1/action_items?id=eq.${encodeURIComponent(item.id)}&user_id=eq.${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'completed', completed_at: now, updated_at: now }),
    }),
  ]);

  return res.status(200).json({ ok: true });
};
