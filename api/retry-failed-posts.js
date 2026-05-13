// Force retry all failed posts from today
// GET /api/retry-failed-posts?secret=CRON_SECRET

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
  return { ok: res.ok, status: res.status, data, text };
}

export default async function handler(req, res) {
  // Auth check
  const secret = req.query.secret;
  if (!CRON_SECRET || secret !== CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  try {
    // Get today's UTC date range
    const now = new Date();
    const todayStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0, 0, 0
    )).toISOString();

    // Find all failed posts from today
    const filter = `status=eq.failed&created_at=gte.${encodeURIComponent(todayStart)}`;
    const { data: posts, ok: loadOk } = await supabaseFetch(
      `/rest/v1/social_posts?${filter}&select=id,platform,persona,error_message`
    );

    if (!loadOk) {
      return res.status(502).json({ ok: false, error: 'Failed to load failed posts' });
    }

    const failed = Array.isArray(posts) ? posts : [];

    if (failed.length === 0) {
      return res.status(200).json({
        ok: true,
        message: 'No failed posts found from today',
        retried: 0,
      });
    }

    // Reset all to approved for retry
    const now_iso = new Date().toISOString();
    const ids = failed.map(p => p.id);
    const idsFilter = ids.map(id => `id.eq.${encodeURIComponent(id)}`).join(',');

    const { ok: patchOk, data: patched } = await supabaseFetch(
      `/rest/v1/social_posts?or=(${idsFilter})`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          status: 'approved',
          approved_at: now_iso,
          error_message: null,
          publishing_started_at: null,
        }),
      }
    );

    if (!patchOk) {
      return res.status(502).json({
        ok: false,
        error: 'Failed to reset posts',
        found: failed.length,
      });
    }

    const retried = Array.isArray(patched) ? patched.length : 0;

    return res.status(200).json({
      ok: true,
      message: `Reset ${retried} failed posts to approved for retry`,
      retried,
      posts: failed.map(p => ({
        id: p.id,
        platform: p.platform,
        persona: p.persona,
        previous_error: p.error_message,
      })),
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
