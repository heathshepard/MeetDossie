// Vercel Serverless Function: /api/trec-updates
//
// Customer-facing TREC Watch feed.
//   GET  /api/trec-updates                           → list recent updates for signed-in user
//   GET  /api/trec-updates?unread_only=1             → unread only
//   POST /api/trec-updates/mark-read                 → body: { id }  mark a notification read
//   POST /api/trec-updates/mark-all-read             → mark all this user's unread as read
//
// Auth: Bearer <supabase user JWT>
//
// SV-TREC-SCANNER-003 (Atlas, 2026-07-08).

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
    if (
      ALLOWED_ORIGINS.has(origin) ||
      LOCALHOST_ORIGIN_RE.test(origin) ||
      origin.endsWith('.vercel.app') ||
      origin.endsWith('.meetdossie.com')
    ) {
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
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { ok: res.ok, status: res.status, data };
}

async function listForUser(userId, unreadOnly) {
  // Pull this user's notification rows, joined to the update details.
  // PostgREST embedded resource pattern.
  const readFilter = unreadOnly ? '&read_at=is.null' : '';
  const notifRes = await supabaseFetch(
    `/rest/v1/trec_update_notifications?user_id=eq.${userId}${readFilter}&channel=eq.in_app&order=sent_at.desc&limit=50&select=id,read_at,sent_at,channel,trec_update:trec_updates(id,source_url,source_type,title,summary,effective_date,affects_forms,severity,scanned_at)`
  );
  if (!notifRes.ok) return { rows: [], error: notifRes.data };

  const rows = (notifRes.data || []).map((n) => ({
    notification_id: n.id,
    read_at: n.read_at,
    sent_at: n.sent_at,
    ...n.trec_update,
  }));

  // Unread count independent of unreadOnly filter
  const cntRes = await supabaseFetch(
    `/rest/v1/trec_update_notifications?user_id=eq.${userId}&channel=eq.in_app&read_at=is.null&select=id`,
    { headers: { Prefer: 'count=exact' } }
  );
  const cntHeader = cntRes.ok && cntRes.data ? cntRes.data.length : 0;

  return { rows, unread_count: cntHeader };
}

async function markRead(userId, notificationId) {
  const res = await supabaseFetch(
    `/rest/v1/trec_update_notifications?id=eq.${notificationId}&user_id=eq.${userId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ read_at: new Date().toISOString() }),
      headers: { Prefer: 'return=minimal' },
    }
  );
  return res.ok;
}

async function markAllRead(userId) {
  const res = await supabaseFetch(
    `/rest/v1/trec_update_notifications?user_id=eq.${userId}&read_at=is.null`,
    {
      method: 'PATCH',
      body: JSON.stringify({ read_at: new Date().toISOString() }),
      headers: { Prefer: 'return=minimal' },
    }
  );
  return res.ok;
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') {
    return res.status(corsAllowed ? 204 : 403).end();
  }
  if (!corsAllowed) {
    return res.status(403).json({ ok: false, error: 'origin_not_allowed' });
  }

  let auth;
  try {
    auth = await verifySupabaseToken(req);
  } catch (e) {
    if (e instanceof AuthError) {
      return res.status(e.status).json({ ok: false, error: e.message });
    }
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const userId = auth.userId;
  const urlPath = (req.url || '').split('?')[0];

  try {
    if (req.method === 'GET') {
      const unreadOnly = req.query && (req.query.unread_only === '1' || req.query.unread_only === 'true');
      const { rows, unread_count } = await listForUser(userId, unreadOnly);
      return res.status(200).json({ ok: true, updates: rows, unread_count });
    }

    if (req.method === 'POST' && /mark-all-read/.test(urlPath)) {
      const ok = await markAllRead(userId);
      return res.status(ok ? 200 : 500).json({ ok });
    }

    if (req.method === 'POST' && /mark-read/.test(urlPath)) {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const id = body.id || (req.query && req.query.id);
      if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });
      const ok = await markRead(userId, String(id));
      return res.status(ok ? 200 : 500).json({ ok });
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (e) {
    console.error('[trec-updates] handler error', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
