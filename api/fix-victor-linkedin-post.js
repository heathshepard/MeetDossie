// Temporary endpoint to mark Victor's duplicate LinkedIn post as posted
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

    // Find Victor's LinkedIn posts from today with 409 or duplicate error
    const url = `${SUPABASE_URL}/rest/v1/social_posts?platform=eq.linkedin&persona=eq.victor&created_at=gte.${startTime}&created_at=lte.${endTime}&select=id,post_id,hook,status,error_message,created_at`;

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

    // Filter for posts with 409 or duplicate in error message
    const duplicatePosts = posts.filter(p =>
      p.error_message && (
        p.error_message.includes('409') ||
        p.error_message.toLowerCase().includes('duplicate')
      )
    );

    if (duplicatePosts.length === 0) {
      return res.status(200).json({
        message: 'No duplicate LinkedIn posts found for Victor today',
        allPosts: posts.map(p => ({
          id: p.id,
          hook: (p.hook || '').substring(0, 50),
          status: p.status,
          error: p.error_message,
        })),
      });
    }

    // Update each duplicate post to posted status
    const results = [];
    for (const post of duplicatePosts) {
      const updateUrl = `${SUPABASE_URL}/rest/v1/social_posts?id=eq.${post.id}`;
      const updateRes = await fetch(updateUrl, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          status: 'posted',
          error_message: null,
        }),
      });

      results.push({
        id: post.id,
        hook: (post.hook || '').substring(0, 50),
        updated: updateRes.ok,
        oldStatus: post.status,
        newStatus: 'posted',
      });
    }

    return res.status(200).json({
      message: `Updated ${duplicatePosts.length} duplicate post(s) to posted status`,
      results,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Internal error', message: err.message });
  }
};
