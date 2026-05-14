// POST /api/reset-posts-by-ids
// Resets specific posts to approved status by post_id
// Auth: Authorization: Bearer ${CRON_SECRET}
// Body: { post_ids: ["post_id1", "post_id2", ...] }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const { post_ids } = req.body || {};

  if (!post_ids || !Array.isArray(post_ids) || post_ids.length === 0) {
    return res.status(400).json({ ok: false, error: 'Missing or invalid post_ids array' });
  }

  try {
    const updates = [];

    for (const postId of post_ids) {
      const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/social_posts?post_id=eq.${encodeURIComponent(postId)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: 'return=representation',
        },
        body: JSON.stringify({
          status: 'approved',
          error_message: null,
          publishing_started_at: null,
        }),
      });

      if (updateRes.ok) {
        const updated = await updateRes.json();
        if (updated && updated.length > 0) {
          updates.push({ post_id: postId, status: 'success' });
        }
      } else {
        updates.push({ post_id: postId, status: 'failed', error: updateRes.statusText });
      }
    }

    return res.status(200).json({
      ok: true,
      count: updates.filter(u => u.status === 'success').length,
      results: updates,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
