// POST /api/reset-failed-posts
// Resets all failed posts from a specific date back to approved status
// Auth: Authorization: Bearer ${CRON_SECRET}
// Body: { date: "YYYY-MM-DD" } (optional, defaults to today)

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

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const { date } = req.body || {};
  const targetDate = date || new Date().toISOString().split('T')[0];
  const startTime = `${targetDate}T00:00:00`;
  const endTime = `${targetDate}T23:59:59`;

  try {
    // First, get all failed posts from the target date
    const getResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/social_posts?created_at=gte.${startTime}&created_at=lte.${endTime}&status=eq.failed&select=id,platform,hook`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    if (!getResponse.ok) {
      return res.status(502).json({
        ok: false,
        error: 'Failed to fetch posts from Supabase',
        status: getResponse.status,
      });
    }

    const posts = await getResponse.json();

    if (posts.length === 0) {
      return res.status(200).json({
        ok: true,
        message: 'No failed posts found',
        date: targetDate,
        count: 0,
      });
    }

    // Update all failed posts to approved
    const updateResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/social_posts?created_at=gte.${startTime}&created_at=lte.${endTime}&status=eq.failed`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          status: 'approved',
          error_message: null,
          publishing_started_at: null,
        }),
      }
    );

    if (!updateResponse.ok) {
      const errorText = await updateResponse.text();
      return res.status(502).json({
        ok: false,
        error: 'Failed to update posts',
        status: updateResponse.status,
        details: errorText,
      });
    }

    return res.status(200).json({
      ok: true,
      message: 'Successfully reset failed posts to approved',
      date: targetDate,
      count: posts.length,
      posts: posts.map(p => ({
        id: p.id,
        platform: p.platform,
        hook: p.hook?.substring(0, 50) || 'no hook',
      })),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
