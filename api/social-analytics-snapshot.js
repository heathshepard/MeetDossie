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

    // Fetch post_analytics + social_posts data
    const { data: analyticsData, error: analyticsError } = await supabase
      .from('post_analytics')
      .select('*, social_posts!inner(id, platform, persona, hook, topic)');

    if (analyticsError) {
      console.error('[social-analytics-snapshot] analytics query failed:', analyticsError.message);
      return res.status(500).json({ error: 'Could not fetch analytics data' });
    }

    const posts = analyticsData || [];

    // 7-day rollup
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentPosts = posts.filter(p => {
      const d = p.created_at ? new Date(p.created_at) : null;
      return d && d >= thirtyDaysAgo;
    });

    const totalPostsSent = recentPosts.length;
    const totalLikes = recentPosts.reduce((sum, p) => sum + (parseInt(p.likes, 10) || 0), 0);
    const totalComments = recentPosts.reduce((sum, p) => sum + (parseInt(p.comments, 10) || 0), 0);
    const totalReshares = recentPosts.reduce((sum, p) => sum + (parseInt(p.reshares, 10) || 0), 0);

    // Platform breakdown
    const platformMap = {};
    recentPosts.forEach(p => {
      const platform = p.social_posts?.platform || 'unknown';
      if (!platformMap[platform]) {
        platformMap[platform] = { posts: 0, likes: 0, comments: 0, reshares: 0 };
      }
      platformMap[platform].posts += 1;
      platformMap[platform].likes += parseInt(p.likes, 10) || 0;
      platformMap[platform].comments += parseInt(p.comments, 10) || 0;
      platformMap[platform].reshares += parseInt(p.reshares, 10) || 0;
    });

    const platformBreakdown = Object.entries(platformMap).map(([platform, data]) => ({
      platform,
      posts_sent: data.posts,
      avg_likes: data.posts > 0 ? Math.round(data.likes / data.posts * 10) / 10 : 0,
      avg_comments: data.posts > 0 ? Math.round(data.comments / data.posts * 10) / 10 : 0,
      avg_reshares: data.posts > 0 ? Math.round(data.reshares / data.posts * 10) / 10 : 0,
      total_likes: data.likes,
      total_comments: data.comments,
      total_reshares: data.reshares,
    }));

    // Persona breakdown
    const personaMap = {};
    recentPosts.forEach(p => {
      const persona = p.social_posts?.persona || 'unknown';
      if (!personaMap[persona]) {
        personaMap[persona] = { posts: 0, likes: 0, comments: 0, reshares: 0 };
      }
      personaMap[persona].posts += 1;
      personaMap[persona].likes += parseInt(p.likes, 10) || 0;
      personaMap[persona].comments += parseInt(p.comments, 10) || 0;
      personaMap[persona].reshares += parseInt(p.reshares, 10) || 0;
    });

    const personaBreakdown = Object.entries(personaMap).map(([persona, data]) => ({
      persona,
      posts: data.posts,
      avg_engagement: data.posts > 0 ? Math.round((data.likes + data.comments + data.reshares) / data.posts * 10) / 10 : 0,
      total_likes: data.likes,
      total_comments: data.comments,
      total_reshares: data.reshares,
    }));

    // Top hooks + topics
    const hookTopicMap = {};
    recentPosts.forEach(p => {
      const hook = p.social_posts?.hook || 'unknown';
      const topic = p.social_posts?.topic || 'unknown';
      const key = `${hook}|${topic}`;
      if (!hookTopicMap[key]) {
        hookTopicMap[key] = { hook, topic, engagement_points: 0, posts: 0 };
      }
      hookTopicMap[key].engagement_points += (parseInt(p.likes, 10) || 0) + (parseInt(p.comments, 10) || 0) + (parseInt(p.reshares, 10) || 0);
      hookTopicMap[key].posts += 1;
    });

    const topHookTopics = Object.values(hookTopicMap)
      .map(item => ({
        ...item,
        avg_engagement: item.posts > 0 ? Math.round(item.engagement_points / item.posts * 10) / 10 : 0,
      }))
      .sort((a, b) => b.avg_engagement - a.avg_engagement)
      .slice(0, 5);

    // Recent posts feed (last 20)
    const recentPostsFeed = recentPosts
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      .slice(0, 20)
      .map(p => ({
        id: p.id,
        platform: p.social_posts?.platform || 'unknown',
        persona: p.social_posts?.persona || 'unknown',
        hook: p.social_posts?.hook || 'unknown',
        topic: p.social_posts?.topic || 'unknown',
        created_at: p.created_at,
        likes: parseInt(p.likes, 10) || 0,
        comments: parseInt(p.comments, 10) || 0,
        reshares: parseInt(p.reshares, 10) || 0,
        total_engagement: (parseInt(p.likes, 10) || 0) + (parseInt(p.comments, 10) || 0) + (parseInt(p.reshares, 10) || 0),
      }));

    // 30-day daily rollup for growth chart
    const dailyMap = {};
    recentPosts.forEach(p => {
      const d = p.created_at ? new Date(p.created_at).toISOString().split('T')[0] : null;
      if (!d) return;
      if (!dailyMap[d]) dailyMap[d] = 0;
      dailyMap[d] += (parseInt(p.likes, 10) || 0) + (parseInt(p.comments, 10) || 0) + (parseInt(p.reshares, 10) || 0);
    });

    const growthChart = Object.entries(dailyMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, engagement]) => ({ date, engagement }));

    // Determine top platform
    const topPlatform = platformBreakdown.length > 0
      ? platformBreakdown.reduce((max, p) => p.total_likes + p.total_comments + p.total_reshares > max.total_likes + max.total_comments + max.total_reshares ? p : max)
      : null;

    return res.status(200).json({
      ok: true,
      summary: {
        total_posts_sent: totalPostsSent,
        total_likes: totalLikes,
        total_comments: totalComments,
        total_reshares: totalReshares,
        top_platform: topPlatform?.platform || null,
      },
      platform_breakdown: platformBreakdown,
      persona_breakdown: personaBreakdown,
      top_hook_topics: topHookTopics,
      recent_posts_feed: recentPostsFeed,
      growth_chart: growthChart,
    });
  } catch (err) {
    console.error('[social-analytics-snapshot] error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
