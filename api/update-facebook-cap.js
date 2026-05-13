// Temporarily update Facebook daily cap
// GET /api/update-facebook-cap?cap=2&secret=CRON_SECRET

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

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

export default async function handler(req, res) {
  const secret = req.query.secret;
  const cap = parseInt(req.query.cap) || 1;

  if (!CRON_SECRET || secret !== CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    // Update all Facebook posting_schedule rows
    const updateRes = await supabaseFetch(
      `/rest/v1/posting_schedule?platform=eq.facebook`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ max_per_day: cap }),
      }
    );

    return res.status(200).json({
      ok: true,
      updated: Array.isArray(updateRes.data) ? updateRes.data.length : 0,
      new_cap: cap,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
