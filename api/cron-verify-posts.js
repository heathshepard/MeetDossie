// Vercel Serverless Function: /api/cron-verify-posts
// Runs at :45 past every hour. Checks whether each platform published
// within the last 90 minutes if a posting window was expected. If a
// platform missed its window, retries immediately via Zernio and sends
// a Telegram alert.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: vercel.json — "45 * * * *"

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const { retryFetch } = require('./_lib/retry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

const ZERNIO_POSTS_URL = 'https://zernio.com/api/v1/posts';

// Zernio account IDs (from CLAUDE.md section 22)
const ZERNIO_ACCOUNT_IDS = {
  facebook:  '69f253c3985e734bf3d8f9bc',
  instagram: '69f25431985e734bf3d8fcbe',
  twitter:   '69f255c6985e734bf3d90ba1',
  linkedin:  '69fccd7392b3d8e85f8f12be',
  tiktok:    '69f15791985e734bf3d13b89',
};

// Expected posting windows per platform — CDT hours (UTC-5 in summer).
// CDT = UTC - 5, so 8 AM CDT = 13 UTC, 9 AM CDT = 14 UTC, etc.
// We store as UTC hours for comparison.
const WINDOWS_CDT = {
  facebook:  [9, 12, 18],
  instagram: [8, 18],
  twitter:   [8, 12, 16],
  tiktok:    [7, 19],
  linkedin:  [8],
};

// Convert CDT hours to UTC hours (CDT = UTC - 5)
const CDT_TO_UTC_OFFSET = 5;
const WINDOWS_UTC = {};
for (const [platform, hours] of Object.entries(WINDOWS_CDT)) {
  WINDOWS_UTC[platform] = hours.map((h) => (h + CDT_TO_UTC_OFFSET) % 24);
}

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
  return { ok: res.ok, status: res.status, data };
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    });
  } catch (err) {
    console.error('[cron-verify-posts] Telegram send failed:', err && err.message);
  }
}

// Count posts with status='posted' for a platform in the last 90 minutes.
async function countPostedRecently(platform) {
  const cutoff = new Date(Date.now() - 90 * 60 * 1000).toISOString();
  const filter = `platform=eq.${encodeURIComponent(platform)}&status=eq.posted&posted_at=gte.${encodeURIComponent(cutoff)}&select=id`;
  const { data, ok } = await supabaseFetch(`/rest/v1/social_posts?${filter}`);
  if (!ok || !Array.isArray(data)) return 0;
  return data.length;
}

// Fetch oldest approved post for a platform (to retry).
async function fetchApprovedPost(platform) {
  const filter = `platform=eq.${encodeURIComponent(platform)}&status=eq.approved&posted_at=is.null&select=id,content,hashtags,media_url,platform,zernio_account_id,persona,scheduled_for&order=approved_at.asc.nullslast&limit=1`;
  const { data, ok } = await supabaseFetch(`/rest/v1/social_posts?${filter}`);
  if (!ok || !Array.isArray(data) || data.length === 0) return null;
  const post = data[0];
  // Ensure zernio_account_id is populated even if DB row is missing it
  if (!post.zernio_account_id) {
    post.zernio_account_id = ZERNIO_ACCOUNT_IDS[platform] || null;
  }
  return post;
}

function buildPostBody(post) {
  const hashtags = Array.isArray(post.hashtags) ? post.hashtags : [];
  const tagLine = hashtags.length
    ? '\n\n' + hashtags.map((h) => `#${String(h).replace(/^#/, '')}`).join(' ')
    : '';
  const content = String(post.content || '');
  const text = /\B#\w/.test(content) ? content : `${content}${tagLine}`;
  return text.trim();
}

function inferMediaItem(url) {
  const u = String(url || '').toLowerCase();
  let type = 'image';
  if (/\.(mp4|mov|avi|webm|mkv)(?:$|\?)/i.test(u)) type = 'video';
  return { url, type };
}

async function pushToZernio(post) {
  if (!post.zernio_account_id) return { ok: false, error: 'no zernio_account_id on row' };
  const text = buildPostBody(post);

  const platformBlock = {
    platform: post.platform,
    accountId: post.zernio_account_id,
  };

  let topContent = text;
  let topMediaItems;
  if (post.media_url) {
    topMediaItems = [inferMediaItem(post.media_url)];
  }

  const payload = {
    content: topContent,
    platforms: [platformBlock],
    publishNow: true,
  };
  if (topMediaItems) payload.mediaItems = topMediaItems;

  console.log(`[cron-verify-posts] Zernio retry payload for ${post.id} (${post.platform}):`, JSON.stringify(payload).slice(0, 300));

  try {
    const res = await retryFetch(
      ZERNIO_POSTS_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ZERNIO_API_KEY}`,
        },
        body: JSON.stringify(payload),
      },
      { name: 'Zernio-verify-retry', maxAttempts: 2, baseDelay: 2000 }
    );
    const respText = await res.text();
    let data = null;
    try { data = respText ? JSON.parse(respText) : null; } catch { data = null; }

    console.log(`[cron-verify-posts] Zernio retry response for ${post.id}: status=${res.status}, body=${respText.slice(0, 300)}`);

    if (!res.ok) {
      return { ok: false, status: res.status, error: `Zernio API ${res.status}: ${respText.slice(0, 300)}` };
    }
    const zernioPostId = data?.id || data?.post_id || data?.postId || data?.data?.id || null;
    return { ok: true, zernio_post_id: zernioPostId };
  } catch (err) {
    return { ok: false, error: `Zernio exception: ${err && err.message}` };
  }
}

async function tryAcquirePublishLock(postId) {
  const enc = encodeURIComponent(postId);
  const res = await supabaseFetch(`/rest/v1/social_posts?id=eq.${enc}&status=eq.approved`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      status: 'publishing',
      publishing_started_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) return false;
  return Array.isArray(res.data) && res.data.length > 0;
}

// Main handler
module.exports = withTelemetry('cron-verify-posts', async function handler(req, res) {
  // Auth: accept Vercel's built-in cron header OR manual Bearer token.
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const now = new Date();
  const currentUtcHour = now.getUTCHours();

  console.log(`[cron-verify-posts] Running at UTC ${currentUtcHour}:${now.getUTCMinutes().toString().padStart(2, '0')}`);

  const report = [];
  const retried = [];
  const missed = [];

  for (const [platform, utcWindows] of Object.entries(WINDOWS_UTC)) {
    // Skip TikTok — it requires video and is handled by the DONE pipeline.
    if (platform === 'tiktok') {
      console.log(`[cron-verify-posts] skipping tiktok (video-only pipeline)`);
      continue;
    }

    // Check if we're within 90 minutes after any expected posting window.
    const windowMatched = utcWindows.some((windowHour) => {
      const diffMin = (currentUtcHour - windowHour + 24) % 24 * 60 + now.getUTCMinutes();
      // Within 90 minutes AFTER the window (not before)
      return diffMin >= 0 && diffMin <= 90;
    });

    if (!windowMatched) {
      console.log(`[cron-verify-posts] ${platform}: no active window at UTC ${currentUtcHour} — skipping`);
      continue;
    }

    // Check if this platform posted in the last 90 minutes.
    const recentCount = await countPostedRecently(platform);
    console.log(`[cron-verify-posts] ${platform}: ${recentCount} post(s) in last 90min`);

    if (recentCount > 0) {
      report.push({ platform, status: 'ok', recentCount });
      continue;
    }

    // Check for an approved post before deciding whether to alert.
    // An empty queue (all rejected or nothing generated) is expected — not a crisis.
    const post = await fetchApprovedPost(platform);
    if (!post) {
      console.log(`[cron-verify-posts] ${platform}: no approved posts in queue — nothing to retry (queue empty after rejections or single-post day)`);
      report.push({ platform, status: 'queue_empty' });
      continue;
    }

    // An approved post exists but didn't fire — that is a genuine missed window. Alert and retry.
    const cdtHour = WINDOWS_CDT[platform].find((h) => {
      const utcH = (h + CDT_TO_UTC_OFFSET) % 24;
      const elapsedMin = ((currentUtcHour - utcH + 24) % 24) * 60 + now.getUTCMinutes();
      return elapsedMin >= 0 && elapsedMin <= 90;
    }) || WINDOWS_CDT[platform][0];

    console.warn(`[cron-verify-posts] ${platform}: approved post ${post.id} not published — missed ${cdtHour}:00 CDT window`);
    await sendTelegram(`<b>WARNING ${platform.toUpperCase()} MISSED POST WINDOW</b>\n\n${platform} had no posts in the last 90 minutes (expected window: ${cdtHour}:00 CDT). Retrying now...`);
    missed.push(platform);

    if (!ZERNIO_API_KEY) {
      console.error('[cron-verify-posts] ZERNIO_API_KEY not configured — cannot retry');
      await sendTelegram(`<b>CRITICAL: ${platform.toUpperCase()} RETRY FAILED</b>\n\nZernio API key not configured. Manual intervention required.`);
      report.push({ platform, status: 'retry_skipped', reason: 'no ZERNIO_API_KEY' });
      continue;
    }

    // Instagram requires media.
    if (platform === 'instagram' && !post.media_url) {
      console.warn(`[cron-verify-posts] ${platform}: skipping instagram retry — no media_url`);
      await sendTelegram(`<b>WARNING: ${platform.toUpperCase()} retry blocked</b>\n\nInstagram post ${post.id} has no image card. Cannot publish without media_url.`);
      report.push({ platform, status: 'instagram_no_media' });
      continue;
    }

    // Soft-lock the row before calling Zernio.
    const acquired = await tryAcquirePublishLock(post.id);
    if (!acquired) {
      console.warn(`[cron-verify-posts] ${platform}: could not acquire lock for post ${post.id} — another run may have grabbed it`);
      report.push({ platform, status: 'lock_not_acquired' });
      continue;
    }

    // Push to Zernio.
    const result = await pushToZernio(post);

    if (result.ok) {
      // Mark posted.
      await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'posted',
          posted_at: new Date().toISOString(),
          publishing_started_at: null,
          zernio_post_id: result.zernio_post_id,
          error_message: null,
        }),
      });
      console.log(`[cron-verify-posts] ${platform}: retry SUCCESS for post ${post.id}`);
      await sendTelegram(`<b>RECOVERED: ${platform.toUpperCase()} post published</b>\n\nPost ${post.id} successfully sent to ${platform} on retry.`);
      retried.push({ platform, post_id: post.id, success: true });
      report.push({ platform, status: 'retried_ok', post_id: post.id });
    } else {
      // Mark failed.
      await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'failed',
          publishing_started_at: null,
          error_message: String(result.error || 'verify-cron retry failed').slice(0, 500),
        }),
      });
      console.error(`[cron-verify-posts] ${platform}: retry FAILED for post ${post.id}:`, result.error);
      await sendTelegram(`<b>CRITICAL: ${platform.toUpperCase()} RETRY FAILED</b>\n\nPost ${post.id} could not be published on retry.\n\nError: ${String(result.error || 'unknown').slice(0, 200)}\n\nManual intervention required.`);
      retried.push({ platform, post_id: post.id, success: false, error: result.error });
      report.push({ platform, status: 'retried_failed', post_id: post.id, error: result.error });
    }
  }

  console.log('[cron-verify-posts] done. report:', JSON.stringify(report));

  return res.status(200).json({
    ok: true,
    utc_hour: currentUtcHour,
    report,
    missed,
    retried,
  });
});
