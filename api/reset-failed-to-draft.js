// GET /api/reset-failed-to-draft?date=2026-05-14
// Reset today's failed posts to draft status

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
  return await res.json();
}

export default async function handler(req, res) {
  const date = req.query.date || new Date().toISOString().split('T')[0];

  try {
    // Update failed posts to draft status and reset fields
    const result = await supabaseFetch(
      `/rest/v1/social_posts?status=eq.failed&created_at=gte.${date}T00:00:00`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          status: 'draft',
          error_message: null,
          telegram_sent_at: null,
          telegram_message_id: null,
        }),
      }
    );

    if (!Array.isArray(result)) {
      return res.status(500).json({ ok: false, error: 'Invalid response', result });
    }

    return res.status(200).json({
      ok: true,
      reset_count: result.length,
      posts: result.map(p => ({
        post_id: p.post_id,
        platform: p.platform,
        status: p.status,
      })),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}
