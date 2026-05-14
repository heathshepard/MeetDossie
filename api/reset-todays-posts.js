// POST /api/reset-todays-posts
// Resets all of today's posts (except old TikTok) to approved with fresh timestamp
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

  const today = new Date().toISOString().split('T')[0];

  try {
    // Update all today's posts except the old TikTok one
    const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/social_posts?created_at=gte.${today}T00:00:00&created_at=lt.${today}T23:59:59&post_id=neq.2026-05-05-victor-tiktok-5`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        status: 'approved',
        approved_at: new Date().toISOString(),
        publishing_started_at: null,
        error_message: null,
        posted_at: null,
      }),
    });

    if (!updateRes.ok) {
      const error = await updateRes.text();
      return res.status(502).json({
        ok: false,
        error: 'Failed to update posts',
        status: updateRes.status,
        details: error,
      });
    }

    const updated = await updateRes.json();

    // Verify
    const verifyRes = await fetch(`${SUPABASE_URL}/rest/v1/social_posts?created_at=gte.${today}T00:00:00&created_at=lt.${today}T23:59:59&post_id=neq.2026-05-05-victor-tiktok-5&select=post_id,platform,status,approved_at`, {
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      }
    });

    const posts = await verifyRes.json();

    return res.status(200).json({
      ok: true,
      updated: updated.length,
      verified: posts.length,
      posts: posts.map(p => ({
        post_id: p.post_id,
        platform: p.platform,
        status: p.status,
        approved_at: p.approved_at,
      })),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
