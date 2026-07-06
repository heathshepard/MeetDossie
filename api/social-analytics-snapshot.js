/**
 * Social Analytics Snapshot API
 * Returns aggregated social post analytics data for the dashboard
 * Auth: requires logged-in user (any authenticated user)
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth check
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - no token' });
  }

  const token = authHeader.replace('Bearer ', '');
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // Verify token and get user
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Unauthorized - invalid token' });
    }

    // Fetch post_analytics data (sync_date, platform, persona, hook, topic are direct columns)
    const { data: analyticsData, error: analyticsError } = await supabase
      .from('post_analytics')
      .select('*');

    if (analyticsError) {
      console.error('[social-analytics-snapshot] analytics query failed:', analyticsError.message);
      return res.status(500).json({ error: 'Could not fetch analytics data' });
    }

    const posts = analyticsData || [];

    // 30-day rollup (filter by sync_date)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const recentPosts = posts.filter(p => {
      // sync_date is a string formatted as YYYY-MM-DD
      return p.sync_date && p.sync_date >= thirtyDaysAgo;
    });

    const totalPostsSent = recentPosts.length;
    const totalLikes = recentPosts.reduce((sum, p) => sum + (parseInt(p.likes, 10) || 0), 0);
    const totalComments = recentPosts.reduce((sum, p) => sum + (parseInt(p.comments, 10) || 0), 0);
    const totalShares = recentPosts.reduce((sum, p) => sum + (parseInt(p.shares, 10) || 0), 0);

    // Platform breakdown (read platform directly from post_analytics)
    const platformMap = {};
    recentPosts.forEach(p => {
      const platform = p.platform || 'unknown';
      if (!platformMap[platform]) {
        platformMap[platform] = { posts: 0, likes: 0, comments: 0, shares: 0 };
      }
      platformMap[platform].posts += 1;
      platformMap[platform].likes += parseInt(p.likes, 10) || 0;
      platformMap[platform].comments += parseInt(p.comments, 10) || 0;
      platformMap[platform].shares += parseInt(p.shares, 10) || 0;
    });

    const platformBreakdown = Object.entries(platformMap).map(([platform, data]) => ({
      platform,
      posts_sent: data.posts,
      avg_likes: data.posts > 0 ? Math.round(data.likes / data.posts * 10) / 10 : 0,
      avg_comments: data.posts > 0 ? Math.round(data.comments / data.posts * 10) / 10 : 0,
      avg_shares: data.posts > 0 ? Math.round(data.shares / data.posts * 10) / 10 : 0,
      total_likes: data.likes,
      total_comments: data.comments,
      total_shares: data.shares,
    }));

    // Persona breakdown (read persona directly)
    const personaMap = {};
    recentPosts.forEach(p => {
      const persona = p.persona || 'unknown';
      if (!personaMap[persona]) {
        personaMap[persona] = { posts: 0, likes: 0, comments: 0, shares: 0 };
      }
      personaMap[persona].posts += 1;
      personaMap[persona].likes += parseInt(p.likes, 10) || 0;
      personaMap[persona].comments += parseInt(p.comments, 10) || 0;
      personaMap[persona].shares += parseInt(p.shares, 10) || 0;
    });

    const personaBreakdown = Object.entries(personaMap).map(([persona, data]) => ({
      persona,
      posts: data.posts,
      avg_engagement: data.posts > 0 ? Math.round((data.likes + data.comments + data.shares) / data.posts * 10) / 10 : 0,
      total_likes: data.likes,
      total_comments: data.comments,
      total_shares: data.shares,
    }));

    // Top hooks + topics (read hook/topic directly)
    const hookTopicMap = {};
    recentPosts.forEach(p => {
      const hook = p.hook || 'unknown';
      const topic = p.topic || 'unknown';
      const key = `${hook}|${topic}`;
      if (!hookTopicMap[key]) {
        hookTopicMap[key] = { hook, topic, engagement_points: 0, posts: 0 };
      }
      hookTopicMap[key].engagement_points += (parseInt(p.likes, 10) || 0) + (parseInt(p.comments, 10) || 0) + (parseInt(p.shares, 10) || 0);
      hookTopicMap[key].posts += 1;
    });

    const topHookTopics = Object.values(hookTopicMap)
      .map(item => ({
        ...item,
        avg_engagement: item.posts > 0 ? Math.round(item.engagement_points / item.posts * 10) / 10 : 0,
      }))
      .sort((a, b) => b.avg_engagement - a.avg_engagement)
      .slice(0, 5);

    // Recent posts feed (last 20, sorted by sync_date descending)
    const recentPostsFeed = recentPosts
      .sort((a, b) => (b.sync_date || '').localeCompare(a.sync_date || ''))
      .slice(0, 20)
      .map(p => ({
        id: p.id,
        platform: p.platform || 'unknown',
        persona: p.persona || 'unknown',
        hook: p.hook || 'unknown',
        topic: p.topic || 'unknown',
        sync_date: p.sync_date,
        likes: parseInt(p.likes, 10) || 0,
        comments: parseInt(p.comments, 10) || 0,
        shares: parseInt(p.shares, 10) || 0,
        total_engagement: (parseInt(p.likes, 10) || 0) + (parseInt(p.comments, 10) || 0) + (parseInt(p.shares, 10) || 0),
      }));

    // 30-day daily rollup for growth chart
    const dailyMap = {};
    recentPosts.forEach(p => {
      const d = p.sync_date || null;
      if (!d) return;
      if (!dailyMap[d]) dailyMap[d] = 0;
      dailyMap[d] += (parseInt(p.likes, 10) || 0) + (parseInt(p.comments, 10) || 0) + (parseInt(p.shares, 10) || 0);
    });

    const growthChart = Object.entries(dailyMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, engagement]) => ({ date, engagement }));

    // Top platform
    const topPlatform = platformBreakdown.length > 0
      ? platformBreakdown.reduce((best, curr) =>
          (best.total_likes + best.total_comments + best.total_shares) <
          (curr.total_likes + curr.total_comments + curr.total_shares)
            ? curr
            : best
        ).platform
      : 'unknown';

    return res.status(200).json({
      summary: {
        posts_sent: totalPostsSent,
        total_likes: totalLikes,
        total_comments: totalComments,
        total_shares: totalShares,
        top_platform: topPlatform,
      },
      platform_breakdown: platformBreakdown,
      persona_breakdown: personaBreakdown,
      top_hook_topics: topHookTopics,
      recent_posts: recentPostsFeed,
      growth_chart: growthChart,
    });
  } catch (error) {
    console.error('[social-analytics-snapshot] error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
