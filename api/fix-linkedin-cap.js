// GET /api/fix-linkedin-cap
// Update LinkedIn daily cap from 0 to 1

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  try {
    const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/posting_schedule?platform=eq.linkedin`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ max_per_day: 1 }),
    });

    const result = await updateRes.json();

    return res.status(200).json({
      ok: updateRes.ok,
      updated: result,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
