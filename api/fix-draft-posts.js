// Emergency fix: approve all draft posts from today
// GET /api/fix-draft-posts?secret=CRON_SECRET

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

    // Find all draft posts from today that were sent to Telegram for approval
    const filter = `status=eq.draft&telegram_sent_at=gte.${encodeURIComponent(todayStart)}&telegram_sent_at=not.is.null`;
    const { data: posts, ok: loadOk } = await supabaseFetch(
      `/rest/v1/social_posts?${filter}&select=id,platform,persona,hook,created_at,telegram_sent_at`
    );

    if (!loadOk) {
      return res.status(502).json({ ok: false, error: 'Failed to load draft posts' });
    }

    const drafts = Array.isArray(posts) ? posts : [];

    if (drafts.length === 0) {
      return res.status(200).json({
        ok: true,
        message: 'No draft posts found from today',
        fixed: 0,
      });
    }

    // Approve all of them
    const now_iso = new Date().toISOString();
    const ids = drafts.map(p => p.id);
    const idsFilter = ids.map(id => `id.eq.${encodeURIComponent(id)}`).join(',');

    const { ok: patchOk, data: patched } = await supabaseFetch(
      `/rest/v1/social_posts?or=(${idsFilter})`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          status: 'approved',
          approved_at: now_iso,
        }),
      }
    );

    if (!patchOk) {
      return res.status(502).json({
        ok: false,
        error: 'Failed to approve posts',
        found: drafts.length,
      });
    }

    const fixed = Array.isArray(patched) ? patched.length : 0;

    return res.status(200).json({
      ok: true,
      message: `Approved ${fixed} posts`,
      fixed,
      posts: drafts.map(p => ({
        id: p.id,
        platform: p.platform,
        persona: p.persona,
        hook: p.hook,
      })),
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
