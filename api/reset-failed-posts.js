// POST /api/reset-failed-posts
// Resets all failed posts back to approved status
// Auth: Authorization: Bearer ${CRON_SECRET}

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

  try {
    // Reset all failed posts to approved
    const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/social_posts?status=eq.failed`, {
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

    if (!updateRes.ok) {
      const error = await updateRes.text();
      return res.status(502).json({
        ok: false,
        error: 'Failed to reset posts',
        details: error,
      });
    }

    const posts = await updateRes.json();

    return res.status(200).json({
      ok: true,
      count: posts.length,
      posts: posts.map(p => ({ post_id: p.post_id, platform: p.platform })),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
