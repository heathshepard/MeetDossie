// GET /api/debug-failed-posts?date=2026-05-14
// Get complete details on failed posts including telegram status

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
    const result = await supabaseFetch(
      `/rest/v1/social_posts?created_at=gte.${date}T00:00:00&select=post_id,platform,status,error_message,telegram_sent_at,telegram_message_id,publishing_started_at,posted_at,approved_at,created_at`
    );

    if (!Array.isArray(result)) {
      return res.status(500).json({ ok: false, error: 'Invalid response', result });
    }

    return res.status(200).json({
      ok: true,
      date,
      total: result.length,
      posts: result.map(p => ({
        post_id: p.post_id,
        platform: p.platform,
        status: p.status,
        error_message: p.error_message,
        telegram_sent_at: p.telegram_sent_at,
        telegram_message_id: p.telegram_message_id,
        publishing_started_at: p.publishing_started_at,
        posted_at: p.posted_at,
        approved_at: p.approved_at,
        created_at: p.created_at,
      })),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}
