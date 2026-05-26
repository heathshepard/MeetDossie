// Vercel Serverless Function: /api/cron-post-videos
// Runs at 11:30 UTC (6:30am CST) daily.
// Picks the oldest 'approved' video from video_library and posts it to
// Zernio for each platform in the platforms array.
//
// The video must already be uploaded to Supabase Storage (supabase_url set)
// before this cron fires. If supabase_url is null, the video is skipped with
// a warning — run scripts/upload-video.py first.
//
// Auth: Vercel cron header OR Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — "30 11 * * *"

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

const ZERNIO_POSTS_URL = 'https://zernio.com/api/v1/posts';

// Zernio account IDs — matches api/cron-publish-approved.js
const ZERNIO_ACCOUNTS = {
  tiktok:    '69f15791985e734bf3d13b89',
  instagram: '69f25431985e734bf3d8fcbe',
  facebook:  '69f253c3985e734bf3d8f9bc',
  twitter:   '69f255c6985e734bf3d90ba1',
  linkedin:  '69fccd7392b3d8e85f8f12be',
};

// Default: post video to ALL 5 platforms unless overridden by video.platforms row
const DEFAULT_PLATFORMS = ['tiktok', 'instagram', 'facebook', 'twitter', 'linkedin'];

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

async function sendTelegramNotification(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('[cron-post-videos] Telegram notify failed:', err && err.message);
  }
}

async function postToZernio(platform, videoUrl, caption) {
  const accountId = ZERNIO_ACCOUNTS[platform];
  if (!accountId) {
    return { ok: false, error: `No Zernio account ID for platform: ${platform}` };
  }

  const payload = {
    content: caption,
    mediaItems: [{ url: videoUrl, type: 'video' }],
    platforms: [{ platform, accountId }],
    publishNow: true,
  };

  console.log(`[cron-post-videos] Posting to ${platform}:`, JSON.stringify(payload).slice(0, 300));

  try {
    const res = await fetch(ZERNIO_POSTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ZERNIO_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }

    console.log(`[cron-post-videos] Zernio ${platform}: status=${res.status} body=${text.slice(0, 300)}`);

    if (!res.ok) {
      return { ok: false, error: `Zernio ${res.status}: ${text.slice(0, 300)}`, data };
    }
    return { ok: true, data, zernio_post_id: data?.id || data?.post_id || null };
  } catch (err) {
    return { ok: false, error: `Zernio exception: ${err && err.message}` };
  }
}

module.exports = async function handler(req, res) {
  // Auth check
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
    console.error('[cron-post-videos] ZERNIO_API_KEY not configured');
    return res.status(200).json({ ok: true, skipped: true, reason: 'zernio not configured' });
  }

  // Query for the oldest approved video
  const { data: rows, ok: loadOk } = await supabaseFetch(
    '/rest/v1/video_library?status=eq.approved&order=created_at.asc&limit=1',
  );

  if (!loadOk) {
    return res.status(502).json({ ok: false, error: 'Failed to query video_library' });
  }

  const video = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;

  if (!video) {
    console.log('[cron-post-videos] No approved videos — nothing to do');
    return res.status(200).json({ ok: true, message: 'no approved videos' });
  }

  console.log(`[cron-post-videos] Processing approved video: ${video.id}`);

  // Check supabase_url is set — required for Zernio video post
  if (!video.supabase_url) {
    const warn = `Video ${video.id} is approved but supabase_url is null — run scripts/upload-video.py first`;
    console.warn(`[cron-post-videos] ${warn}`);
    await sendTelegramNotification(`Video pipeline: ${warn}`);
    return res.status(200).json({ ok: true, skipped: true, reason: warn });
  }

  // Mark as posting (soft lock)
  const { ok: lockOk } = await supabaseFetch(
    `/rest/v1/video_library?id=eq.${encodeURIComponent(video.id)}&status=eq.approved`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'posting' }),
    },
  );

  if (!lockOk) {
    return res.status(502).json({ ok: false, error: 'Failed to acquire posting lock' });
  }

  const platforms = (Array.isArray(video.platforms) && video.platforms.length > 0)
    ? video.platforms
    : DEFAULT_PLATFORMS;
  const caption = video.caption || '';
  const results = [];
  let allOk = true;

  for (const platform of platforms) {
    const result = await postToZernio(platform, video.supabase_url, caption);
    results.push({ platform, ...result });
    if (!result.ok) {
      allOk = false;
      console.error(`[cron-post-videos] Failed on ${platform}:`, result.error);
    } else {
      console.log(`[cron-post-videos] Posted to ${platform} OK`);
    }
  }

  if (allOk) {
    await supabaseFetch(
      `/rest/v1/video_library?id=eq.${encodeURIComponent(video.id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'posted',
          posted_date: new Date().toISOString(),
        }),
      },
    );
    await sendTelegramNotification(
      `Video posted: ${video.id}\nPlatforms: ${platforms.join(', ')}\n${caption.slice(0, 100)}`,
    );
    console.log(`[cron-post-videos] Video ${video.id} posted successfully`);
  } else {
    const errorSummary = results
      .filter((r) => !r.ok)
      .map((r) => `${r.platform}: ${r.error}`)
      .join('; ');

    await supabaseFetch(
      `/rest/v1/video_library?id=eq.${encodeURIComponent(video.id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'failed',
          posted_date: null,
        }),
      },
    );
    await sendTelegramNotification(
      `Video post FAILED: ${video.id}\nErrors: ${errorSummary}`,
    );
    console.error(`[cron-post-videos] Video ${video.id} failed:`, errorSummary);
  }

  return res.status(200).json({
    ok: allOk,
    video_id: video.id,
    platforms_attempted: platforms,
    results,
  });
};
