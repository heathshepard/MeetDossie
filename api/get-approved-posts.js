// GET /api/get-approved-posts
// Returns all approved posts ready to publish (for n8n workflow)
// Auth: Authorization: Bearer ${CRON_SECRET}

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
  // Auth check
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  try {
    const filter = 'status=eq.approved&posted_at=is.null&select=id,post_id,platform,content,media_url,zernio_account_id,hashtags';
    const { data: posts, ok: loadOk } = await supabaseFetch(`/rest/v1/social_posts?${filter}`);

    if (!loadOk) {
      return res.status(502).json({ ok: false, error: 'Failed to load approved posts' });
    }

    const items = Array.isArray(posts) ? posts : [];

    return res.status(200).json({
      ok: true,
      count: items.length,
      posts: items,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
