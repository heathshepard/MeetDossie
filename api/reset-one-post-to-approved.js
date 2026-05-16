// TEMPORARY: Reset one failed post to approved status
// GET /api/reset-one-post-to-approved?post_id=<id>

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

  const post_id = req.query.post_id;

  if (!post_id) {
    // No post_id provided - query for one failed post from today
    const today = new Date().toISOString().split('T')[0];
    const { data: failed } = await supabaseFetch(
      `/rest/v1/social_posts?status=eq.failed&created_at=gte.${today}T00:00:00&order=created_at.desc&limit=1`
    );

    if (!Array.isArray(failed) || failed.length === 0) {
      return res.status(404).json({ ok: false, error: 'No failed posts found today' });
    }

    const post = failed[0];

    // Reset to approved
    const { ok: patchOk, data: patched } = await supabaseFetch(
      `/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          status: 'approved',
          error_message: null,
          publishing_started_at: null,
          approved_at: new Date().toISOString(),
        }),
      }
    );

    if (!patchOk) {
      return res.status(502).json({ ok: false, error: 'Failed to update post' });
    }

    const updated = Array.isArray(patched) && patched.length > 0 ? patched[0] : null;

    return res.status(200).json({
      ok: true,
      post: {
        id: updated.id,
        post_id: updated.post_id,
        platform: updated.platform,
        status: updated.status,
        error_message: updated.error_message,
        publishing_started_at: updated.publishing_started_at,
      },
    });
  } else {
    // Specific post_id provided - reset it
    const { ok: patchOk, data: patched } = await supabaseFetch(
      `/rest/v1/social_posts?post_id=eq.${encodeURIComponent(post_id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          status: 'approved',
          error_message: null,
          publishing_started_at: null,
          approved_at: new Date().toISOString(),
        }),
      }
    );

    if (!patchOk) {
      return res.status(502).json({ ok: false, error: 'Failed to update post' });
    }

    const updated = Array.isArray(patched) && patched.length > 0 ? patched[0] : null;

    if (!updated) {
      return res.status(404).json({ ok: false, error: 'Post not found' });
    }

    return res.status(200).json({
      ok: true,
      post: {
        id: updated.id,
        post_id: updated.post_id,
        platform: updated.platform,
        status: updated.status,
        error_message: updated.error_message,
        publishing_started_at: updated.publishing_started_at,
      },
    });
  }
}
