// api/admin-ridge-incidents.js
// ============================================================================
// SV-ENG-RIDGE-WATCHDOG-001 (Ridge, 2026-07-09)
//
// Admin read of customer_experience_incidents. Auth-gated to heath@ user only.
//
// GET /api/admin-ridge-incidents
//   ?resolved=false   → only unresolved (default)
//   ?limit=100        → cap results
//
// POST /api/admin-ridge-incidents
//   body: { id, resolved: true, resolved_notes: '...' }
//   Marks an incident as resolved. Only allowed for Heath.
// ============================================================================

'use strict';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function verifyHeathToken(token) {
  if (!token) return { ok: false, error: 'missing token' };
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!r.ok) return { ok: false, error: `token verify ${r.status}` };
    const data = await r.json();
    if (!data || !data.email) return { ok: false, error: 'no email on token' };
    if (data.email !== 'heath.shepard@kw.com') {
      return { ok: false, error: 'forbidden' };
    }
    return { ok: true, user: data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function sbSelect(query) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!r.ok) return { ok: false, status: r.status, data: null };
  const data = await r.json();
  return { ok: true, status: r.status, data };
}

async function sbPatch(query, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, status: r.status, data: null };
  const data = await r.json();
  return { ok: true, status: r.status, data };
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const auth = await verifyHeathToken(token);
  if (!auth.ok) return res.status(auth.error === 'forbidden' ? 403 : 401).json({ ok: false, error: auth.error });

  if (req.method === 'GET') {
    const q = req.query || {};
    const resolvedFilter = q.resolved === 'true' ? 'eq.true' : q.resolved === 'all' ? null : 'eq.false';
    const limit = Math.min(parseInt(q.limit || '100', 10) || 100, 500);

    let query = `customer_experience_incidents?select=*&order=created_at.desc&limit=${limit}`;
    if (resolvedFilter) query += `&resolved=${resolvedFilter}`;

    const r = await sbSelect(query);
    if (!r.ok) return res.status(500).json({ ok: false, error: `sb ${r.status}` });
    return res.status(200).json({ ok: true, incidents: r.data, count: r.data.length });
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    if (!body.id) return res.status(400).json({ ok: false, error: 'missing id' });
    if (body.resolved !== true && body.resolved !== false) {
      return res.status(400).json({ ok: false, error: 'resolved must be boolean' });
    }
    const patch = {
      resolved: body.resolved,
      resolved_at: body.resolved ? new Date().toISOString() : null,
      resolved_notes: body.resolved_notes ? String(body.resolved_notes).slice(0, 500) : null,
    };
    const r = await sbPatch(`customer_experience_incidents?id=eq.${encodeURIComponent(body.id)}`, patch);
    if (!r.ok) return res.status(500).json({ ok: false, error: `sb ${r.status}` });
    return res.status(200).json({ ok: true, updated: r.data });
  }

  return res.status(405).json({ ok: false, error: 'method not allowed' });
};
