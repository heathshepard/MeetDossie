// Temporary endpoint to check Twitter brenda post status
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const today = '2026-05-19';
    const startTime = `${today}T00:00:00`;
    const endTime = `${today}T23:59:59`;

    // Query for Twitter posts from today
    const url = `${SUPABASE_URL}/rest/v1/social_posts?platform=eq.twitter&created_at=gte.${startTime}&created_at=lte.${endTime}&select=id,post_id,platform,persona,hook,status,error_message,created_at&order=created_at.desc`;

    const response = await fetch(url, {
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(500).json({ error: 'Supabase query failed', details: text });
    }

    const posts = await response.json();
    const brendaPosts = posts.filter(p => p.persona === 'brenda');
    const failedBrendaPosts = brendaPosts.filter(p => p.status === 'failed');

    return res.status(200).json({
      totalTwitterPosts: posts.length,
      brendaPosts: brendaPosts.length,
      failedBrendaPosts: failedBrendaPosts.length,
      posts: posts.map(p => ({
        id: p.id,
        persona: p.persona,
        status: p.status,
        hook: (p.hook || '').substring(0, 60),
        error: p.error_message,
        created_at: p.created_at
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: 'Internal error', message: err.message });
  }
};
