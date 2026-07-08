// Vercel Serverless Function: /api/cron-pull-post-analytics
// PHASE 2 - Analytics Engagement Pull
//
// Runs daily at 6 AM UTC (2 AM CDT).
// Pulls engagement metrics from each platform for posts from last 7 days
// where zernio_post_id IS NOT NULL (verified posts only).
//
// For each post, queries:
//   - Zernio unified analytics (if available per their API)
//   - Fallback: per-platform APIs directly (Facebook Graph, Twitter API v2, etc.)
//
// Inserts one row per post per day into post_analytics table (idempotent via UNIQUE).
//
// Auth:     Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — "0 6 * * *" (6 AM UTC daily).

const { retryFetch } = require('./_lib/retry.js');
const { recordCronRun } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// Platform-specific API keys (fall back to Zernio unified if not available)
const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN; // Page access token
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;   // API v2 bearer
const LINKEDIN_ACCESS_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;

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

// Query Zernio's unified analytics endpoint (if it exists).
// Zernio v1 docs may expose analytics via GET /posts/:id/analytics or similar.
async function fetchZernioAnalytics(zernioPostId) {
  try {
    const res = await retryFetch(
      `https://zernio.com/api/v1/posts/${encodeURIComponent(zernioPostId)}/analytics`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ZERNIO_API_KEY}`,
        },
      },
      { name: 'Zernio-analytics', maxAttempts: 2, baseDelay: 1000 }
    );

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }

    if (!res.ok) {
      console.warn(`[fetchZernioAnalytics] ${zernioPostId}: ${res.status}`);
      return null;
    }

    return data;
  } catch (err) {
    console.warn(`[fetchZernioAnalytics] ${zernioPostId}: ${err.message}`);
    return null;
  }
}

// Placeholder: per-platform analytics fetchers
// These are stubbed — real implementation requires platform-specific OAuth tokens
// and may not be available on the free Zernio plan.

async function fetchFacebookAnalytics(postId, accessToken) {
  if (!accessToken || !postId) return null;
  try {
    const res = await retryFetch(
      `https://graph.facebook.com/v18.0/${encodeURIComponent(postId)}?fields=shares,likes.summary(true),comments.summary(true)&access_token=${encodeURIComponent(accessToken)}`,
      { method: 'GET' },
      { name: 'Facebook-analytics', maxAttempts: 2, baseDelay: 500 }
    );
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (err) {
    console.warn(`[fetchFacebookAnalytics] ${postId}: ${err.message}`);
    return null;
  }
}

async function fetchTwitterAnalytics(tweetId, bearerToken) {
  if (!bearerToken || !tweetId) return null;
  try {
    // Twitter API v2: GET /tweets/:id?metrics=public_metrics
    const res = await retryFetch(
      `https://api.twitter.com/2/tweets/${encodeURIComponent(tweetId)}?tweet.fields=public_metrics`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${bearerToken}`,
        },
      },
      { name: 'Twitter-analytics', maxAttempts: 2, baseDelay: 500 }
    );
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (err) {
    console.warn(`[fetchTwitterAnalytics] ${tweetId}: ${err.message}`);
    return null;
  }
}

async function fetchInstagramAnalytics(mediaId, accessToken) {
  if (!accessToken || !mediaId) return null;
  try {
    const res = await retryFetch(
      `https://graph.instagram.com/v18.0/${encodeURIComponent(mediaId)}?fields=like_count,comments_count&access_token=${encodeURIComponent(accessToken)}`,
      { method: 'GET' },
      { name: 'Instagram-analytics', maxAttempts: 2, baseDelay: 500 }
    );
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (err) {
    console.warn(`[fetchInstagramAnalytics] ${mediaId}: ${err.message}`);
    return null;
  }
}

async function fetchLinkedInAnalytics(postUrn, accessToken) {
  if (!accessToken || !postUrn) return null;
  try {
    const res = await retryFetch(
      `https://api.linkedin.com/v2/ugcPosts/${encodeURIComponent(postUrn)}?projection=(elements*(lifecycleState,socialMetadata))`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
      { name: 'LinkedIn-analytics', maxAttempts: 2, baseDelay: 500 }
    );
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (err) {
    console.warn(`[fetchLinkedInAnalytics] ${postUrn}: ${err.message}`);
    return null;
  }
}

// Compute engagement rate from raw metrics
function computeEngagementRate(likes, comments, shares, reach) {
  if (!reach || reach <= 0) return null;
  const totalEngagement = (likes || 0) + (comments || 0) + (shares || 0);
  return (totalEngagement / reach) * 100;
}

// Parse analytics from mixed sources and normalize to post_analytics schema
function normalizeAnalytics(platform, rawData) {
  if (!rawData) return null;

  let normalized = {
    platform,
    impressions: null,
    reach: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    profile_clicks: null,
    link_clicks: null,
    engagement_rate: null,
    raw_response: rawData,
  };

  // Zernio response format (if available)
  if (rawData.impressions !== undefined) normalized.impressions = rawData.impressions;
  if (rawData.reach !== undefined) normalized.reach = rawData.reach;
  if (rawData.likes !== undefined) normalized.likes = rawData.likes;
  if (rawData.comments !== undefined) normalized.comments = rawData.comments;
  if (rawData.shares !== undefined) normalized.shares = rawData.shares;
  if (rawData.saves !== undefined) normalized.saves = rawData.saves;
  if (rawData.profile_clicks !== undefined) normalized.profile_clicks = rawData.profile_clicks;
  if (rawData.link_clicks !== undefined) normalized.link_clicks = rawData.link_clicks;

  // Facebook response: { likes: { data: [...], summary: { total_count } }, ... }
  if (platform === 'facebook') {
    if (rawData.likes?.summary?.total_count) normalized.likes = rawData.likes.summary.total_count;
    if (rawData.comments?.summary?.total_count) normalized.comments = rawData.comments.summary.total_count;
    if (rawData.shares) normalized.shares = rawData.shares;
  }

  // Twitter response: { data: { public_metrics: { like_count, retweet_count, reply_count, quote_count } } }
  if (platform === 'twitter') {
    const pm = rawData.data?.public_metrics || rawData.public_metrics;
    if (pm) {
      normalized.likes = pm.like_count || pm.likes;
      normalized.comments = pm.reply_count || pm.replies;
      normalized.shares = pm.retweet_count || (pm.quote_count || 0);
      if (pm.impression_count) normalized.impressions = pm.impression_count;
    }
  }

  // Instagram response: { like_count, comments_count }
  if (platform === 'instagram') {
    if (rawData.like_count) normalized.likes = rawData.like_count;
    if (rawData.comments_count) normalized.comments = rawData.comments_count;
  }

  // LinkedIn response: { elements: [ { socialMetadata: { likes, comments } } ] }
  if (platform === 'linkedin') {
    const elem = Array.isArray(rawData.elements) ? rawData.elements[0] : null;
    if (elem?.socialMetadata) {
      normalized.likes = elem.socialMetadata.likes;
      normalized.comments = elem.socialMetadata.comments;
    }
  }

  // Compute engagement rate if we have reach/impressions
  const reach = normalized.reach || normalized.impressions || 1;
  if (reach > 0) {
    normalized.engagement_rate = computeEngagementRate(
      normalized.likes,
      normalized.comments,
      normalized.shares,
      reach
    );
  }

  return normalized;
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

    // Query: status='posted' AND posted_at >= 7 days ago AND zernio_post_id IS NOT NULL
    // SELECT now includes hook, cta, hook_type, cta_type, topic, persona for analytics enrichment
    const filter = `status=eq.posted&posted_at=gte.${encodeURIComponent(sevenDaysAgo)}&zernio_post_id=not.is.null&zernio_verified_at=not.is.null&select=id,post_id,platform,zernio_post_id,actual_platform_url,posted_at,content,hook,cta,hook_type,cta_type,topic,persona`;

    const { data: items, ok: loadOk } = await supabaseFetch(
      `/rest/v1/social_posts?${filter}&order=posted_at.desc&limit=500`
    );

    if (!loadOk) {
      console.error('[cron-pull-post-analytics] failed to load posts');
      return res.status(502).json({ ok: false, error: 'failed to load posts' });
    }

    const queue = Array.isArray(items) ? items : [];
    console.log('[cron-pull-post-analytics] verified posts in last 7d:', queue.length);

    let pulled = 0;
    let skipped = 0;
    const failures = [];

    for (const post of queue) {
      if (!post || !post.id) continue;

      // Fetch analytics based on platform
      let rawAnalytics = null;
      let source = 'unknown';

      // Try Zernio unified first
      if (post.zernio_post_id) {
        rawAnalytics = await fetchZernioAnalytics(post.zernio_post_id);
        if (rawAnalytics) {
          source = 'zernio-unified';
        }
      }

      // Fallback to per-platform APIs if Zernio didn't return anything
      if (!rawAnalytics) {
        if (post.platform === 'facebook' && FACEBOOK_ACCESS_TOKEN && post.actual_platform_url) {
          rawAnalytics = await fetchFacebookAnalytics(post.post_id, FACEBOOK_ACCESS_TOKEN);
          source = 'facebook-graph';
        } else if (post.platform === 'twitter' && TWITTER_BEARER_TOKEN && post.actual_platform_url) {
          // Extract tweet ID from URL (if available), otherwise use zernio_post_id as fallback
          rawAnalytics = await fetchTwitterAnalytics(post.zernio_post_id, TWITTER_BEARER_TOKEN);
          source = 'twitter-api-v2';
        } else if (post.platform === 'instagram' && FACEBOOK_ACCESS_TOKEN && post.actual_platform_url) {
          rawAnalytics = await fetchInstagramAnalytics(post.post_id, FACEBOOK_ACCESS_TOKEN);
          source = 'instagram-graph';
        } else if (post.platform === 'linkedin' && LINKEDIN_ACCESS_TOKEN && post.actual_platform_url) {
          rawAnalytics = await fetchLinkedInAnalytics(post.post_id, LINKEDIN_ACCESS_TOKEN);
          source = 'linkedin-api';
        }
      }

      if (!rawAnalytics) {
        console.warn(`[cron-pull-post-analytics] no analytics available for ${post.id} (${post.platform})`);
        skipped++;
        continue;
      }

      console.log(`[cron-pull-post-analytics] pulled ${post.platform} analytics for ${post.id} (source=${source})`);

      // Normalize and insert
      const normalized = normalizeAnalytics(post.platform, rawAnalytics);
      if (!normalized) {
        skipped++;
        continue;
      }

      const insertBody = {
        social_post_id: post.id,
        platform: normalized.platform,
        fetched_at: now.toISOString(),
        impressions: normalized.impressions,
        reach: normalized.reach,
        likes: normalized.likes,
        comments: normalized.comments,
        shares: normalized.shares,
        saves: normalized.saves,
        profile_clicks: normalized.profile_clicks,
        link_clicks: normalized.link_clicks,
        engagement_rate: normalized.engagement_rate,
        raw_response: normalized.raw_response,
        // ADDED: content enrichment fields for Sage A/B ranking
        hook: post.hook || null,
        hook_type: post.hook_type || null,
        cta_type: post.cta_type || null,
        topic: post.topic || null,
        persona: post.persona || null,
      };

      const insertResp = await supabaseFetch(
        '/rest/v1/post_analytics',
        {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(insertBody),
        }
      );

      if (insertResp.ok) {
        pulled++;
        console.log(`[cron-pull-post-analytics] inserted analytics for ${post.id}`);
      } else {
        console.error(`[cron-pull-post-analytics] insert failed for ${post.id}:`, insertResp.status, insertResp.text?.slice(0, 200));
        failures.push({
          post_id: post.id,
          platform: post.platform,
          error: `insert failed: ${insertResp.status}`,
        });
      }
    }

    console.log('[cron-pull-post-analytics] done — pulled:', pulled, 'skipped:', skipped, 'failures:', failures.length);

    await recordCronRun('cron-pull-post-analytics', 'ok', {
      queue_size: queue.length,
      pulled,
      skipped,
      failures: failures.length,
    });

    return res.status(200).json({
      ok: true,
      queue_size: queue.length,
      pulled,
      skipped,
      failures,
    });
  } catch (e) {
    console.error('[cron-pull-post-analytics] crashed:', e);
    await recordCronRun('cron-pull-post-analytics', 'error', { error: e.message });
    return res.status(500).json({ ok: false, error: e.message });
  }
};
