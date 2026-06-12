// Vercel Serverless Function: /api/cron-sage-intelligence-update
// PHASE 3 - Sage Intelligence Feedback Loop
//
// Runs daily after analytics have been pulled.
// Reads post_analytics from last 7 days.
// Identifies winning patterns (top platform, pillar, persona by engagement).
// Injects recommendations into sage_intelligence table.
// cron-generate-posts.js reads this before drafting daily content.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — "0 7 * * *" (7 AM UTC daily, after pull-analytics at 6 AM).

const { recordCronRun } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

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

// Query Anthropic to identify patterns from analytics data
async function analyzeEngagementPatterns(analyticsData, postsData) {
  if (!ANTHROPIC_API_KEY || !Array.isArray(analyticsData) || analyticsData.length === 0) {
    return null;
  }

  const prompt = `You are Sage, Dossie's content intelligence agent. Analyze the engagement data below and identify:
1. Top 3 winning content patterns (by engagement rate, reach, or comments)
2. Top 3 losing patterns (by engagement rate, low reach, no comments)
3. Which persona (brenda/patricia/victor) is resonating best
4. Which pillar (cost/control/visibility/speed) gets highest engagement
5. Which platform is most effective

Engagement data:
${JSON.stringify(analyticsData.slice(0, 50), null, 2)}

Posts metadata:
${JSON.stringify(postsData.slice(0, 50), null, 2)}

Respond in JSON format:
{
  "top_platform": "facebook|twitter|instagram|linkedin|tiktok",
  "top_persona": "brenda|patricia|victor|mixed",
  "top_pillar": "cost|control|visibility|speed|mixed",
  "winning_patterns": [
    { "pattern": "short description", "reason": "why it worked", "examples": [list of post ids] },
    ...
  ],
  "losing_patterns": [
    { "pattern": "short description", "reason": "why it failed", "examples": [list of post ids] },
    ...
  ],
  "recommendation": "one sentence actionable insight for tomorrow's content"
}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2000,
        system: 'You are a content strategist analyzing social media engagement patterns. Be concise and data-driven. Always return valid JSON.',
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    });

    if (!res.ok) {
      console.error('[sage-intelligence] Anthropic API error:', res.status);
      return null;
    }

    const result = await res.json();
    const textContent = result.content?.find((c) => c.type === 'text');
    if (!textContent) return null;

    // Extract JSON from response
    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('[sage-intelligence] analysis failed:', err.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  // Auth
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const today = now.toISOString().split('T')[0];

    // Check if we've already run today
    const { data: existing, ok: checkOk } = await supabaseFetch(
      `/rest/v1/sage_intelligence?analysis_date=eq.${today}&select=id&limit=1`
    );

    if (checkOk && Array.isArray(existing) && existing.length > 0) {
      console.log(`[sage-intelligence] already ran today (${today}) — skipping`);
      return res.status(200).json({ ok: true, skipped: true, reason: 'already analyzed today' });
    }

    // Load analytics from last 7 days
    const { data: analytics, ok: analyticsOk } = await supabaseFetch(
      `/rest/v1/post_analytics?fetched_at=gte.${encodeURIComponent(sevenDaysAgo)}&order=engagement_rate.desc.nullslast&limit=200`
    );

    if (!analyticsOk || !Array.isArray(analytics)) {
      console.error('[sage-intelligence] failed to load analytics');
      return res.status(502).json({ ok: false, error: 'failed to load analytics' });
    }

    if (analytics.length === 0) {
      console.warn('[sage-intelligence] no analytics available in last 7 days');
      return res.status(200).json({ ok: true, warning: 'no analytics to analyze' });
    }

    console.log(`[sage-intelligence] analyzing ${analytics.length} analytics records`);

    // Load the corresponding posts for context
    const postIds = [...new Set(analytics.map((a) => a.social_post_id))];
    const { data: posts, ok: postsOk } = await supabaseFetch(
      `/rest/v1/social_posts?id=in.(${postIds.map((id) => `"${id}"`).join(',')})`
    );

    const postsById = {};
    if (postsOk && Array.isArray(posts)) {
      posts.forEach((p) => {
        postsById[p.id] = p;
      });
    }

    // Compute aggregate metrics per platform
    const platformStats = {};
    for (const a of analytics) {
      if (!platformStats[a.platform]) {
        platformStats[a.platform] = {
          count: 0,
          total_engagement_rate: 0,
          total_likes: 0,
          total_comments: 0,
          total_reach: 0,
        };
      }
      platformStats[a.platform].count++;
      if (a.engagement_rate) platformStats[a.platform].total_engagement_rate += a.engagement_rate;
      if (a.likes) platformStats[a.platform].total_likes += a.likes;
      if (a.comments) platformStats[a.platform].total_comments += a.comments;
      if (a.reach) platformStats[a.platform].total_reach += a.reach;
    }

    // Find top platform by avg engagement rate
    let topPlatform = 'mixed';
    let topEngagementRate = 0;
    for (const [platform, stats] of Object.entries(platformStats)) {
      const avgRate = stats.total_engagement_rate / stats.count || 0;
      if (avgRate > topEngagementRate) {
        topEngagementRate = avgRate;
        topPlatform = platform;
      }
    }

    console.log('[sage-intelligence] platform stats:', platformStats);
    console.log('[sage-intelligence] top platform:', topPlatform, `(${topEngagementRate.toFixed(2)}% avg engagement)`);

    // Compute aggregate metrics per persona
    const personaStats = {};
    for (const a of analytics) {
      const post = postsById[a.social_post_id];
      if (!post || !post.persona) continue;
      const persona = post.persona;
      if (!personaStats[persona]) {
        personaStats[persona] = {
          count: 0,
          total_engagement_rate: 0,
        };
      }
      personaStats[persona].count++;
      if (a.engagement_rate) personaStats[persona].total_engagement_rate += a.engagement_rate;
    }

    let topPersona = 'mixed';
    let topPersonaRate = 0;
    for (const [persona, stats] of Object.entries(personaStats)) {
      const avgRate = stats.total_engagement_rate / stats.count || 0;
      if (avgRate > topPersonaRate) {
        topPersonaRate = avgRate;
        topPersona = persona;
      }
    }

    console.log('[sage-intelligence] persona stats:', personaStats);
    console.log('[sage-intelligence] top persona:', topPersona, `(${topPersonaRate.toFixed(2)}% avg engagement)`);

    // Run AI analysis to identify patterns
    const analysis = await analyzeEngagementPatterns(
      analytics.map((a) => ({
        platform: a.platform,
        engagement_rate: a.engagement_rate,
        likes: a.likes,
        comments: a.comments,
        reach: a.reach,
        post_id: a.social_post_id,
      })),
      Object.values(postsById).map((p) => ({
        id: p.id,
        platform: p.platform,
        persona: p.persona,
        pillar: p.pillar,
        content: (p.content || '').slice(0, 100),
      }))
    );

    const intelligenceRow = {
      analysis_date: today,
      top_platform: analysis?.top_platform || topPlatform,
      top_pillar: analysis?.top_pillar || 'mixed',
      top_persona: analysis?.top_persona || topPersona,
      winning_patterns: analysis?.winning_patterns || null,
      losing_patterns: analysis?.losing_patterns || null,
      raw_analytics: {
        platform_stats: platformStats,
        persona_stats: personaStats,
        total_records: analytics.length,
      },
    };

    console.log('[sage-intelligence] inserting intelligence row:', JSON.stringify(intelligenceRow).slice(0, 500));

    const insertResp = await supabaseFetch(
      '/rest/v1/sage_intelligence',
      {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(intelligenceRow),
      }
    );

    if (!insertResp.ok) {
      console.error('[sage-intelligence] insert failed:', insertResp.status, insertResp.text?.slice(0, 200));
      return res.status(502).json({ ok: false, error: `insert failed: ${insertResp.status}` });
    }

    console.log('[sage-intelligence] ✅ intelligence row inserted for', today);

    await recordCronRun('cron-sage-intelligence-update', 'ok', {
      analysis_date: today,
      analytics_count: analytics.length,
      top_platform: intelligenceRow.top_platform,
      top_persona: intelligenceRow.top_persona,
    });

    return res.status(200).json({
      ok: true,
      analysis_date: today,
      analytics_count: analytics.length,
      intelligence: intelligenceRow,
    });
  } catch (e) {
    console.error('[cron-sage-intelligence-update] crashed:', e);
    await recordCronRun('cron-sage-intelligence-update', 'error', { error: e.message });
    return res.status(500).json({ ok: false, error: e.message });
  }
};
