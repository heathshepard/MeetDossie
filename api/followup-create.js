// Vercel Serverless Function: POST /api/followup-create
//
// Purpose: durable cloud-native follow-up scheduling for Jarvis (Cole).
// Replaces the session-bound CronCreate pattern — this survives PC crashes,
// Claude Code restarts, and desktop offline windows.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Body: { title, context, due_at, escalation_contact }
//   - title (required) — short label, shown in the Telegram alert
//   - context (optional) — long-form context Jarvis needs when the alert fires
//   - due_at (required) — ISO-8601 timestamp with tz, e.g. "2026-07-06T13:07:00Z"
//   - escalation_contact (optional) — phone/email string surfaced in the alert
//
// Returns: { ok, id } on success; { ok: false, error } on failure.

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

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const context = typeof body.context === 'string' ? body.context : null;
  const due_at_raw = body.due_at;
  const escalation_contact = typeof body.escalation_contact === 'string' ? body.escalation_contact : null;

  if (!title) return res.status(400).json({ ok: false, error: 'title required' });
  if (!due_at_raw) return res.status(400).json({ ok: false, error: 'due_at required' });

  const due_at_date = new Date(due_at_raw);
  if (Number.isNaN(due_at_date.getTime())) {
    return res.status(400).json({ ok: false, error: 'due_at must be a valid ISO-8601 timestamp' });
  }

  const row = {
    title,
    context,
    due_at: due_at_date.toISOString(),
    escalation_contact,
    status: 'pending',
    created_by: typeof body.created_by === 'string' && body.created_by.trim() ? body.created_by.trim() : 'jarvis',
  };

  try {
    const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/followups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify(row),
    });
    const text = await sbRes.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!sbRes.ok) {
      return res.status(500).json({ ok: false, error: 'Supabase insert failed', status: sbRes.status, detail: data || text });
    }
    const created = Array.isArray(data) ? data[0] : data;
    return res.status(200).json({ ok: true, id: created && created.id, followup: created });
  } catch (err) {
    return res.status(500).json({ ok: false, error: (err && err.message) || 'insert failed' });
  }
};
