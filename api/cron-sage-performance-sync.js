'use strict';

// Vercel Serverless: /api/cron-sage-performance-sync
// Daily at 15:00 UTC (10 AM CDT) — syncs post performance data into
// sage_performance_log and updates hook bank scores.
//
// Flow:
//   1. Pull recent posted social_posts (last 7 days)
//   2. Pull matching post_analytics data
//   3. Upsert into sage_performance_log
//   4. Update hook bank scores for any linked hooks
//   5. Auto-flag declining hooks (3+ uses, below median)
//   6. Auto-promote proven hooks (3+ uses, above median)

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  try { return { ok: res.ok, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, data: text }; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, info: 'POST only' });

  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (!CRON_SECRET || auth !== CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json({ ok: false, error: 'missing SUPABASE env' });
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  // 1. Pull recent posted social_posts
  const posts = await sb(
    `/rest/v1/social_posts?status=eq.posted&posted_at=gte.${sevenDaysAgo}&order=posted_at.desc&limit=50&select=id,platform,persona,topic,hook,posted_at`
  );
  if (!posts.ok || !Array.isArray(posts.data)) {
    return res.status(200).json({ ok: false, error: 'failed to fetch posts' });
  }

  // 2. Pull matching analytics
  const analytics = await sb(
    `/rest/v1/post_analytics?order=created_at.desc&limit=100&select=post_id,platform,views,engagement_rate,impressions,likes,comments,shares,saves`
  );
  const analyticsMap = {};
  if (analytics.ok && Array.isArray(analytics.data)) {
    for (const a of analytics.data) {
      if (a.post_id) analyticsMap[a.post_id] = a;
    }
  }

  // 3. Upsert performance log entries
  let synced = 0;
  for (const post of posts.data) {
    const a = analyticsMap[post.id];
    if (!a) continue;

    const logEntry = {
      post_id: post.id,
      platform: post.platform,
      account: 'dossie',
      pillar: mapTopicToPillar(post.topic),
      views: a.views || a.impressions || 0,
      shares: a.shares || 0,
      comments: a.comments || 0,
      saves: a.saves || 0,
      watch_through_rate: a.engagement_rate || null,
    };

    // Check if already logged
    const existing = await sb(
      `/rest/v1/sage_performance_log?post_id=eq.${post.id}&limit=1`
    );
    if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
      await sb(`/rest/v1/sage_performance_log?post_id=eq.${post.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(logEntry),
      });
    } else {
      await sb('/rest/v1/sage_performance_log', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(logEntry),
      });
    }
    synced++;
  }

  // 4. Update hook bank scores
  const allHooks = await sb('/rest/v1/sage_hook_bank?status=in.(untested,tested,proven)&limit=200');
  if (allHooks.ok && Array.isArray(allHooks.data)) {
    for (const hook of allHooks.data) {
      // Find performance entries linked to this hook
      const hookPerf = await sb(
        `/rest/v1/sage_performance_log?hook_id=eq.${hook.id}&limit=20`
      );
      if (!hookPerf.ok || !Array.isArray(hookPerf.data) || hookPerf.data.length === 0) continue;

      const entries = hookPerf.data;
      const avgViews = entries.reduce((sum, e) => sum + (e.views || 0), 0) / entries.length;
      const avgShares = entries.reduce((sum, e) => sum + (e.shares || 0), 0) / entries.length;
      const score = avgViews * 0.4 + avgShares * 100 * 0.6;

      let newStatus = hook.status;
      if (entries.length >= 3 && score > 50) newStatus = 'proven';
      else if (entries.length >= 3 && score < 10) newStatus = 'retired';
      else if (entries.length >= 1) newStatus = 'tested';

      await sb(`/rest/v1/sage_hook_bank?id=eq.${hook.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          avg_performance: Math.round(score * 100) / 100,
          times_used: entries.length,
          status: newStatus,
          updated_at: new Date().toISOString(),
        }),
      });
    }
  }

  return res.status(200).json({ ok: true, synced, total_posts: posts.data.length });
};

function mapTopicToPillar(topic) {
  if (!topic) return null;
  const t = topic.toLowerCase();
  if (t.includes('tip') || t.includes('how') || t.includes('guide') || t.includes('trec') || t.includes('deadline')) return 'educational';
  if (t.includes('neighborhood') || t.includes('local') || t.includes('san antonio') || t.includes('sa ')) return 'hyper-local';
  if (t.includes('founder') || t.includes('story') || t.includes('heath') || t.includes('journey')) return 'personal-brand';
  if (t.includes('testimonial') || t.includes('customer') || t.includes('review') || t.includes('proof')) return 'social-proof';
  if (t.includes('listing') || t.includes('property') || t.includes('walkthrough') || t.includes('tour')) return 'listings';
  return 'educational';
}
