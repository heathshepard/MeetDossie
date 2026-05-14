// GET /api/update-linkedin-schedule
// Update all LinkedIn scheduling rows to max_per_day=1

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

export default async function handler(req, res) {
  try {
    // Update all linkedin rows
    const { ok, status, data } = await supabaseFetch('/rest/v1/posting_schedule?platform=eq.linkedin', {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        max_per_day: 1,
        is_active: true,
      }),
    });

    return res.status(200).json({
      ok,
      status,
      updated: Array.isArray(data) ? data.length : 0,
      rows: data,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}
