// Vercel Serverless Function: /api/action-items
// CRUD endpoint for the action_items table.
//   GET  /api/action-items?transactionId=...&status=...    → list user's items
//   POST /api/action-items                                  → create
//   PATCH /api/action-items                                 → update status
// Authorization: Bearer <supabase user JWT>

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
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
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') {
    return res.status(corsAllowed ? 204 : 403).end();
  }
  if (!corsAllowed) {
    return res.status(403).json({ ok: false, error: 'Origin not allowed.' });
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

  if (req.method === 'GET') {
    const { transactionId, status } = req.query || {};
    let path = `/rest/v1/action_items?user_id=eq.${encodeURIComponent(userId)}&order=due_date.asc`;
    if (transactionId) path += `&transaction_id=eq.${encodeURIComponent(transactionId)}`;
    if (status && status !== 'all') path += `&status=eq.${encodeURIComponent(status)}`;
    const { ok, data } = await supabaseFetch(path);
    if (!ok) return res.status(500).json({ ok: false, error: 'Could not fetch action items' });
    return res.status(200).json({ ok: true, items: Array.isArray(data) ? data : [] });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const { transactionId, actionType, description, assignedToName, assignedToEmail, dueDate, emailSubject, emailBody } = body;
    if (!transactionId || !description) {
      return res.status(400).json({ ok: false, error: 'transactionId and description required' });
    }
    const payload = {
      user_id: userId,
      transaction_id: String(transactionId),
      action_type: actionType || 'general',
      description: String(description),
      assigned_to_name: assignedToName || null,
      assigned_to_email: assignedToEmail || null,
      due_date: dueDate || null,
      email_subject: emailSubject || null,
      email_body: emailBody || null,
      status: 'pending',
    };
    const { ok, data } = await supabaseFetch('/rest/v1/action_items', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    });
    if (!ok) return res.status(500).json({ ok: false, error: 'Could not create action item' });
    return res.status(201).json({ ok: true, item: Array.isArray(data) ? data[0] : data });
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};
    const { id, status, completedAt } = body;
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    const patch = { updated_at: new Date().toISOString() };
    if (status) patch.status = status;
    if (completedAt || status === 'completed') patch.completed_at = completedAt || new Date().toISOString();
    const { ok } = await supabaseFetch(
      `/rest/v1/action_items?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      },
    );
    if (!ok) return res.status(500).json({ ok: false, error: 'Could not update action item' });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, OPTIONS');
  return res.status(405).json({ ok: false, error: 'Method not allowed' });
};
