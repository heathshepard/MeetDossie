// GET /api/debug-posts?post_ids=id1,id2,id3
// Returns detailed post status including publishing_started_at
// Auth: Authorization: Bearer ${CRON_SECRET}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const { post_ids } = req.query;
  if (!post_ids) {
    return res.status(400).json({ ok: false, error: 'Missing post_ids parameter' });
  }

  const ids = post_ids.split(',');
  const results = [];

  try {
    for (const postId of ids) {
      const queryRes = await fetch(`${SUPABASE_URL}/rest/v1/social_posts?post_id=eq.${encodeURIComponent(postId)}&select=post_id,platform,status,approved_at,posted_at,error_message,publishing_started_at,updated_at`, {
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        }
      });

      if (queryRes.ok) {
        const data = await queryRes.json();
        if (data && data.length > 0) {
          results.push(data[0]);
        }
      }
    }

    return res.status(200).json({
      ok: true,
      count: results.length,
      posts: results,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
