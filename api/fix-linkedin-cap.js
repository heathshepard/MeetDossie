// GET /api/fix-linkedin-cap
// Insert or update LinkedIn daily cap to 1

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
    // First, try to check if linkedin row exists
    const { data: existing } = await supabaseFetch('/rest/v1/posting_schedule?platform=eq.linkedin&select=*');

    if (Array.isArray(existing) && existing.length > 0) {
      // Update existing row
      const { ok, data } = await supabaseFetch('/rest/v1/posting_schedule?platform=eq.linkedin', {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ max_per_day: 1, is_active: true }),
      });

      return res.status(200).json({
        ok,
        action: 'updated',
        row: data[0],
      });
    } else {
      // Insert new row
      const { ok, data } = await supabaseFetch('/rest/v1/posting_schedule', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          platform: 'linkedin',
          max_per_day: 1,
          is_active: true,
          time_slots: ['12:00', '18:00'], // Default slots
        }),
      });

      return res.status(200).json({
        ok,
        action: 'inserted',
        row: data[0],
      });
    }
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}
