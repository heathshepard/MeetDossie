// GET /api/get-failed-posts?date=2026-05-14
// Get error messages for failed posts
// Auth: Authorization: Bearer ${CRON_SECRET} (added 2026-06-10 Atlas)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

async function supabaseFetch(path) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  return await res.json();
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const date = req.query.date || new Date().toISOString().split('T')[0];

  try {
    const posts = await supabaseFetch(
      `/rest/v1/social_posts?select=post_id,platform,status,error_message,created_at&status=eq.failed&created_at=gte.${date}T00:00:00&order=created_at.desc`
    );

    if (!Array.isArray(posts)) {
      return res.status(500).json({ error: 'Invalid response from Supabase', response: posts });
    }

    return res.status(200).json({
      date,
      failed_count: posts.length,
      posts: posts.map(p => ({
        post_id: p.post_id,
        platform: p.platform,
        error_message: p.error_message,
        created_at: p.created_at,
      })),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
