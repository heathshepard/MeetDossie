// GET /api/insert-linkedin-schedule
// Insert all 7 LinkedIn scheduling rows (one per day of week)

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
    // Insert all 7 rows (day_of_week 0-6)
    const rows = [];
    for (let day = 0; day <= 6; day++) {
      rows.push({
        platform: 'linkedin',
        day_of_week: day,
        time_slots: ['12:00:00', '18:00:00'],
        timezone: 'America/Chicago',
        is_active: true,
        max_per_day: 1,
      });
    }

    const { ok, status, data } = await supabaseFetch('/rest/v1/posting_schedule', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(rows),
    });

    return res.status(200).json({
      ok,
      status,
      inserted: Array.isArray(data) ? data.length : 0,
      rows: data,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}
