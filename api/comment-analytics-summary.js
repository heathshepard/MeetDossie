// Vercel Serverless Function: /api/comment-analytics-summary
// GET summary of comment engagement across platforms
// Returns last 7d and 30d aggregates

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

module.exports = async function handler(req, res) {
  const { days = '7' } = req.query;
  const lookbackDays = parseInt(days, 10) || 7;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  try {
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

    const { data: analytics, ok: ok1 } = await supabaseFetch(
      `/rest/v1/comment_analytics?captured_at=gte.${encodeURIComponent(cutoffDate)}&limit=500`
    );

    if (!ok1 || !Array.isArray(analytics)) {
      return res.status(502).json({ ok: false, error: 'failed to load comment analytics' });
    }

    // Aggregate by platform
    const byPlatform = {};
    for (const rec of analytics) {
      if (!byPlatform[rec.platform]) {
        byPlatform[rec.platform] = {
          count: 0,
          upvotes: 0,
          reactions: 0,
          replies: 0,
          profile_clicks: 0,
          awards: 0,
          retweets: 0,
        };
      }
      byPlatform[rec.platform].count++;
      if (rec.upvotes) byPlatform[rec.platform].upvotes += rec.upvotes;
      if (rec.reactions) byPlatform[rec.platform].reactions += rec.reactions;
      if (rec.replies) byPlatform[rec.platform].replies += rec.replies;
      if (rec.profile_clicks) byPlatform[rec.platform].profile_clicks += rec.profile_clicks;
      if (rec.awards) byPlatform[rec.platform].awards += rec.awards;
      if (rec.retweets) byPlatform[rec.platform].retweets += rec.retweets;
    }

    // Calculate engagement rates (replies + reactions) / comments
    for (const platform of Object.keys(byPlatform)) {
      const stats = byPlatform[platform];
      const totalEngagement = (stats.replies || 0) + (stats.reactions || 0) + (stats.awards || 0) + (stats.retweets || 0);
      stats.engagement_rate = stats.count > 0 ? (totalEngagement / stats.count).toFixed(2) : '0';
    }

    // Top comments by engagement
    const sortedByEngagement = analytics
      .map((rec) => ({
        comment_id: rec.comment_id,
        platform: rec.platform,
        url: rec.our_comment_url,
        engagement: (rec.upvotes || 0) + (rec.reactions || 0) + (rec.replies || 0) + (rec.awards || 0) + (rec.retweets || 0),
      }))
      .sort((a, b) => b.engagement - a.engagement)
      .slice(0, 10);

    return res.status(200).json({
      ok: true,
      lookback_days: lookbackDays,
      total_comments_tracked: analytics.length,
      by_platform: byPlatform,
      top_performers: sortedByEngagement,
    });
  } catch (e) {
    console.error('[comment-analytics-summary] crashed:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
