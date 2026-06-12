// Vercel Serverless Function: /api/cron-verify-zernio-deliveries
// PHASE 1 - Delivery Verification
//
// Runs every 30 minutes (scheduled in vercel.json).
// Queries for any social_posts marked status='posted' in the last 2 hours
// with a zernio_post_id but NO zernio_verified_at timestamp.
//
// For each such post, queries Zernio's GET /posts/:scheduledPostId endpoint
// to confirm actual delivery + capture platform-specific URL.
//
// Acceptance criteria:
//   - After 2 cron runs, every 'posted' row from last 4h has verified_at OR status='failed'
//   - Telegram alert if failed rate > 30% in 24h window
//
// Auth:     Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — every 30 min ("*/30 * * * *").

const { retryFetch } = require('./_lib/retry.js');
const { recordCronRun } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const ZERNIO_POSTS_API = 'https://zernio.com/api/v1/posts';

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

async function sendTelegramAlert(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false };
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ok: res.ok };
  } catch (err) {
    console.error('[telegram-alert] failed:', err && err.message);
    return { ok: false };
  }
}

// Query Zernio API to check delivery status of a scheduled post.
// POST ID format in Zernio: may be the scheduled post ID returned at publish time.
async function checkZernioDeliveryStatus(zernioPostId) {
  try {
    // Zernio docs: GET /posts/:id returns the post details + status + platform_urls
    const res = await retryFetch(
      `${ZERNIO_POSTS_API}/${encodeURIComponent(zernioPostId)}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ZERNIO_API_KEY}`,
        },
      },
      { name: 'Zernio-status-check', maxAttempts: 3, baseDelay: 1000 }
    );

    const respText = await res.text();
    let data = null;
    try { data = respText ? JSON.parse(respText) : null; } catch { data = null; }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `Zernio ${res.status}: ${respText.slice(0, 300)}`,
        data,
      };
    }

    // Extract post status and platform URLs from Zernio response.
    // Response shape varies — look for common patterns:
    //   { status, platform_urls: { twitter: 'url', ... }, ... }
    //   { posts: [ { status, platform_urls, ... } ] }
    //   { id, platforms: [ { platform, url, status } ] }
    const postData = Array.isArray(data?.posts)
      ? data.posts[0]
      : data?.posts
      ? data
      : data;

    const status = postData?.status || data?.status;
    const platformUrls = postData?.platform_urls || data?.platform_urls || {};
    const platforms = Array.isArray(postData?.platforms) ? postData.platforms : [];

    // Infer main platform URL from the response
    let mainPlatformUrl = null;
    if (Object.keys(platformUrls).length > 0) {
      mainPlatformUrl = Object.values(platformUrls)[0];
    } else if (platforms.length > 0) {
      mainPlatformUrl = platforms[0].url;
    }

    const isLive = status === 'published' || status === 'live' || status === 'posted';

    return {
      ok: true,
      status: res.status,
      data,
      zernio_status: status,
      is_live: isLive,
      platform_url: mainPlatformUrl,
    };
  } catch (err) {
    const errorMsg = err && err.message ? `Zernio exception: ${err.message}` : 'No response from Zernio';
    console.error(`[checkZernioDeliveryStatus] ${zernioPostId}: ${errorMsg}`);
    return {
      ok: false,
      error: errorMsg,
    };
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
  if (!ZERNIO_API_KEY) {
    console.error('[cron-verify-zernio-deliveries] ZERNIO_API_KEY not configured');
    await recordCronRun('cron-verify-zernio-deliveries', 'skipped', { reason: 'zernio not configured' });
    return res.status(200).json({ ok: true, skipped: true, reason: 'zernio not configured' });
  }

  try {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();

    // Query: status='posted' AND posted_at > 2h ago AND zernio_post_id IS NOT NULL
    //        AND zernio_verified_at IS NULL (not yet verified)
    const filter = `status=eq.posted&posted_at=gte.${encodeURIComponent(twoHoursAgo)}&zernio_post_id=not.is.null&zernio_verified_at=is.null&order=posted_at.asc&select=id,post_id,platform,zernio_post_id,posted_at`;

    const { data: items, ok: loadOk } = await supabaseFetch(
      `/rest/v1/social_posts?${filter}&limit=50`
    );

    if (!loadOk) {
      console.error('[cron-verify-zernio-deliveries] failed to load posts:', loadOk);
      return res.status(502).json({ ok: false, error: 'failed to load posts' });
    }

    const queue = Array.isArray(items) ? items : [];
    console.log('[cron-verify-zernio-deliveries] unverified posts in last 2h:', queue.length);

    let verified = 0;
    let failed = 0;
    const failures = [];

    for (const post of queue) {
      if (!post || !post.id || !post.zernio_post_id) continue;

      console.log(`[cron-verify-zernio-deliveries] checking post ${post.id} (${post.platform}) zernio_id=${post.zernio_post_id}`);

      const result = await checkZernioDeliveryStatus(post.zernio_post_id);

      if (result.ok && result.is_live) {
        // Delivery confirmed — mark as verified
        const patch = await supabaseFetch(
          `/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`,
          {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
              zernio_verified_at: new Date().toISOString(),
              actual_platform_url: result.platform_url || null,
              error_message: null, // clear any unverified message
            }),
          }
        );

        if (patch.ok) {
          verified++;
          console.log(`[cron-verify-zernio-deliveries] ✅ verified post ${post.id}`);
        } else {
          console.error(`[cron-verify-zernio-deliveries] patch failed for ${post.id}:`, patch.status);
          failures.push({ id: post.id, reason: 'patch failed' });
        }
      } else if (result.ok && !result.is_live) {
        // Post exists at Zernio but not live yet (processing)
        console.log(`[cron-verify-zernio-deliveries] post ${post.id} still processing at Zernio (status=${result.zernio_status})`);
        // Don't change anything — will recheck next cron run
      } else {
        // Delivery failed or API error — flip to failed status
        failed++;
        const errorMsg = result.error || `Zernio delivery check failed`;
        console.error(`[cron-verify-zernio-deliveries] ❌ post ${post.id} failed: ${errorMsg}`);

        const patch = await supabaseFetch(
          `/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`,
          {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
              status: 'failed',
              error_message: errorMsg,
            }),
          }
        );

        if (patch.ok) {
          console.log(`[cron-verify-zernio-deliveries] marked ${post.id} as failed`);
        } else {
          console.error(`[cron-verify-zernio-deliveries] failed to mark ${post.id} as failed:`, patch.status);
        }

        failures.push({
          id: post.id,
          platform: post.platform,
          error: errorMsg,
        });
      }
    }

    // Check for high failure rate in past 24h
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const { data: last24h, ok: countOk } = await supabaseFetch(
      `/rest/v1/social_posts?status=eq.failed&updated_at=gte.${encodeURIComponent(oneDayAgo)}&select=id`
    );

    const failedCount24h = countOk && Array.isArray(last24h) ? last24h.length : 0;
    const { data: allLast24h, ok: allOk } = await supabaseFetch(
      `/rest/v1/social_posts?posted_at=gte.${encodeURIComponent(oneDayAgo)}&select=id`
    );

    const totalCount24h = allOk && Array.isArray(allLast24h) ? allLast24h.length : 1;
    const failureRate = totalCount24h > 0 ? (failedCount24h / totalCount24h) : 0;

    console.log(`[cron-verify-zernio-deliveries] 24h failure rate: ${failedCount24h}/${totalCount24h} = ${(failureRate * 100).toFixed(1)}%`);

    // Alert if rate exceeds 30%
    if (failureRate > 0.30 && totalCount24h >= 5) {
      const alertMsg = `🚨 <b>Zernio Delivery Crisis</b>\n\n` +
        `Failure rate: <b>${(failureRate * 100).toFixed(1)}%</b> (${failedCount24h}/${totalCount24h} posts)\n` +
        `This run: ${verified} verified, ${failed} failed\n\n` +
        `Check: POST /api/cron-publish-approved logs + Zernio API status`;

      await sendTelegramAlert(alertMsg);
    }

    await recordCronRun('cron-verify-zernio-deliveries', 'ok', {
      unverified_checked: queue.length,
      verified,
      failed,
      failure_rate_24h: (failureRate * 100).toFixed(1),
    });

    return res.status(200).json({
      ok: true,
      unverified_checked: queue.length,
      verified,
      failed,
      failure_rate_24h: (failureRate * 100).toFixed(1),
      failures,
    });
  } catch (e) {
    console.error('[cron-verify-zernio-deliveries] crashed:', e);
    await recordCronRun('cron-verify-zernio-deliveries', 'error', { error: e.message });
    return res.status(500).json({ ok: false, error: e.message });
  }
};
