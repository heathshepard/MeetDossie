// Vercel Serverless Function: POST /api/followup-resolve
//
// Purpose: mark a follow-up row as done (or cancelled) once the awaited thing
// arrives. Idempotent — resolving an already-done row is a no-op success.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Body: { id, resolution?, status? }
//   - id (required) — uuid of the followups row
//   - resolution (optional) — free-text note ("TVC replied, VBC assigned")
//   - status (optional) — 'done' (default) or 'cancelled'

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return await new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase env not configured' });
  }

  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
  }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });

  const status = body.status === 'cancelled' ? 'cancelled' : 'done';
  const resolution = typeof body.resolution === 'string' ? body.resolution : null;

  const patch = {
    status,
    resolved_at: new Date().toISOString(),
    resolution,
  };

  try {
    const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/followups?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify(patch),
    });
    const text = await sbRes.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!sbRes.ok) {
      return res.status(500).json({ ok: false, error: 'Supabase update failed', status: sbRes.status, detail: data || text });
    }
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(404).json({ ok: false, error: 'followup not found', id });
    }
    return res.status(200).json({ ok: true, id, status, followup: data[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: (err && err.message) || 'update failed' });
  }
};
