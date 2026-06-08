// Vercel Serverless Function: /api/cron-post-videos
// Runs at 11:30 UTC (6:30am CST) daily.
//
// REVIEW GATE FLOW (added 2026-05-27):
//   1. Videos with status='approved' are sent to Heath via Telegram for review.
//      Status is set to 'pending_heath_review' — they do NOT auto-post.
//   2. Heath taps Approve → callback sets status='heath_approved'.
//   3. Heath taps Reject  → callback sets status='rejected'.
//   4. On next cron run, only status='heath_approved' videos actually post to Zernio.
//
// This cron also handles the Telegram callback for approve/reject buttons
// via the /api/video-review-callback endpoint (see bottom of this file — separate handler).
//
// Auth: Vercel cron header OR Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — "30 11 * * *"

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
// Use marketing bot (DossieMarketingBot) as primary — same bot the webhook uses for approve/reject callbacks.
// Fall back to Claudy (TELEGRAM_BOT_TOKEN) if marketing token not set.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

const ZERNIO_POSTS_URL = 'https://zernio.com/api/v1/posts';

// Zernio account IDs — matches api/cron-publish-approved.js
// YouTube account ID is read from ZERNIO_YOUTUBE_ACCOUNT_ID env var (set in Vercel dashboard).
// Heath: find this in your Zernio dashboard under Connected Accounts -> YouTube -> Account ID.
const ZERNIO_ACCOUNTS = {
  tiktok:    '69f15791985e734bf3d13b89',
  instagram: '69f25431985e734bf3d8fcbe',
  facebook:  '69f253c3985e734bf3d8f9bc',
  twitter:   '69f255c6985e734bf3d90ba1',
  linkedin:  '69fccd7392b3d8e85f8f12be',
  youtube:   process.env.ZERNIO_YOUTUBE_ACCOUNT_ID || null,
};

// Default: post video to all connected platforms unless overridden by video.platforms row.
// YouTube is included — videos are the only thing YouTube accepts, which matches our video_library content.
const DEFAULT_PLATFORMS = ['tiktok', 'instagram', 'facebook', 'twitter', 'linkedin', 'youtube'];

// Returns set of platforms that already had ANY post today (video or text).
async function getPlatformsPostedToday() {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const iso = todayStart.toISOString();

  // Check social_posts table
  const { data: socialRows } = await supabaseFetch(
    `/rest/v1/social_posts?status=eq.posted&posted_at=gte.${iso}&select=platform`,
  );
  // Check video_library table
  const { data: videoRows } = await supabaseFetch(
    `/rest/v1/video_library?status=eq.posted&posted_date=gte.${iso}&select=platforms`,
  );

  const posted = new Set();
  if (Array.isArray(socialRows)) socialRows.forEach((r) => r.platform && posted.add(r.platform));
  if (Array.isArray(videoRows)) {
    videoRows.forEach((r) => {
      if (Array.isArray(r.platforms)) r.platforms.forEach((p) => posted.add(p));
    });
  }
  return posted;
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

async function sendTelegramMessage(text, extra = {}) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: false,
        ...extra,
      }),
    });
    const data = await res.json();
    return data;
  } catch (err) {
    console.error('[cron-post-videos] Telegram send failed:', err && err.message);
    return null;
  }
}

// Send a video for Heath's review with inline Approve/Reject buttons.
// Sets status='pending_heath_review' first to prevent double-sends.
async function sendForHeathReview(video) {
  // Mark as pending_heath_review so next cron run doesn't re-queue it
  await supabaseFetch(
    `/rest/v1/video_library?id=eq.${encodeURIComponent(video.id)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'pending_heath_review' }),
    },
  );

  const platforms = (Array.isArray(video.platforms) && video.platforms.length > 0)
    ? video.platforms
    : DEFAULT_PLATFORMS;

  const text = [
    `Video ready for review: ${video.topic || video.id}`,
    `Platforms: ${platforms.join(', ')}`,
    ``,
    `Watch it here: ${video.supabase_url}`,
  ].join('\n');

  const inline_keyboard = [[
    { text: 'Approve', callback_data: `video_approve_${video.id}` },
    { text: 'Reject',  callback_data: `video_reject_${video.id}` },
  ]];

  await sendTelegramMessage(text, {
    reply_markup: { inline_keyboard },
  });

  console.log(`[cron-post-videos] Sent ${video.id} to Heath for review`);
}

async function postToZernio(platform, videoUrl, caption, topic) {
  const accountId = ZERNIO_ACCOUNTS[platform];
  if (!accountId) {
    return { ok: false, error: `No Zernio account ID for platform: ${platform}` };
  }

  const platformBlock = { platform, accountId };

  // YouTube requires a title in platformSpecificData.
  // Use topic as title (max 100 chars), fall back to first line of caption.
  if (platform === 'youtube') {
    const rawTitle = topic || caption.split('\n')[0] || 'Dossie - AI Transaction Coordinator for Texas Agents';
    platformBlock.platformSpecificData = {
      title: rawTitle.replace(/[^\w\s\-.,!?'"()&]/g, '').slice(0, 100).trim(),
    };
  }

  const payload = {
    content: caption,
    mediaItems: [{ url: videoUrl, type: 'video' }],
    platforms: [platformBlock],
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
    return { ok: true, data, zernio_post_id: data?.post?._id || data?.id || data?.post_id || null };
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

  const summary = { queued_for_review: [], posted: [], skipped: [] };

  // --- STEP 1: Queue any 'approved' videos for Heath's review (do NOT post them) ---
  const { data: approvedRows, ok: approvedOk } = await supabaseFetch(
    '/rest/v1/video_library?status=eq.approved&order=created_at.asc',
  );

  if (!approvedOk) {
    return res.status(502).json({ ok: false, error: 'Failed to query approved videos' });
  }

  const approvedVideos = Array.isArray(approvedRows) ? approvedRows : [];

  for (const video of approvedVideos) {
    if (!video.supabase_url) {
      const warn = `Video ${video.id} is approved but supabase_url is null — run scripts/upload-video.py first`;
      console.warn(`[cron-post-videos] ${warn}`);
      await sendTelegramMessage(`Video pipeline: ${warn}`);
      summary.skipped.push({ id: video.id, reason: 'no supabase_url' });
      continue;
    }
    await sendForHeathReview(video);
    summary.queued_for_review.push(video.id);
  }

  // --- STEP 2: Post any 'heath_approved' videos to Zernio ---
  const { data: heathApprovedRows, ok: heathApprovedOk } = await supabaseFetch(
    '/rest/v1/video_library?status=eq.heath_approved&order=created_at.asc&limit=1',
  );

  if (!heathApprovedOk) {
    return res.status(502).json({ ok: false, error: 'Failed to query heath_approved videos' });
  }

  const video = Array.isArray(heathApprovedRows) && heathApprovedRows.length > 0
    ? heathApprovedRows[0]
    : null;

  let libraryOk = true;
  let videoResults = [];
  let videoId = null;
  let platformsAttempted = [];

  if (!video) {
    console.log('[cron-post-videos] No heath_approved videos — nothing to post');
  } else {
    videoId = video.id;
    console.log(`[cron-post-videos] Posting heath_approved video: ${video.id}`);

    if (!video.supabase_url) {
      const warn = `Video ${video.id} is heath_approved but supabase_url is null`;
      console.warn(`[cron-post-videos] ${warn}`);
      await sendTelegramMessage(`Video pipeline: ${warn}`);
      summary.skipped.push({ id: video.id, reason: 'no supabase_url' });
    } else {
      const captionCheck = (video.caption || '').trim().toLowerCase();
      if (!captionCheck || captionCheck.startsWith('pulled') || captionCheck.includes('do not repost') || captionCheck.includes('internal')) {
        const warn = `Video ${video.id} has an invalid caption ("${(video.caption || '').slice(0, 60)}") — skipping to prevent internal notes from posting publicly`;
        console.warn(`[cron-post-videos] ${warn}`);
        await sendTelegramMessage(`Video pipeline safety check: ${warn}`);
        await supabaseFetch(
          `/rest/v1/video_library?id=eq.${encodeURIComponent(video.id)}`,
          { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'failed' }) },
        );
        summary.skipped.push({ id: video.id, reason: 'invalid caption' });
      } else {
        const { ok: lockOk } = await supabaseFetch(
          `/rest/v1/video_library?id=eq.${encodeURIComponent(video.id)}&status=eq.heath_approved`,
          {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ status: 'posting' }),
          },
        );

        if (!lockOk) {
          console.error('[cron-post-videos] Failed to acquire posting lock');
          libraryOk = false;
        } else {
          platformsAttempted = (Array.isArray(video.platforms) && video.platforms.length > 0)
            ? video.platforms
            : DEFAULT_PLATFORMS;
          const caption = video.caption || '';

          for (const platform of platformsAttempted) {
            const result = await postToZernio(platform, video.supabase_url, caption, video.topic);
            videoResults.push({ platform, ...result });
            if (!result.ok) {
              libraryOk = false;
              console.error(`[cron-post-videos] Failed on ${platform}:`, result.error);
            } else {
              console.log(`[cron-post-videos] Posted to ${platform} OK`);
            }
          }

          if (libraryOk) {
            await supabaseFetch(
              `/rest/v1/video_library?id=eq.${encodeURIComponent(video.id)}`,
              {
                method: 'PATCH',
                headers: { Prefer: 'return=minimal' },
                body: JSON.stringify({ status: 'posted', posted_date: new Date().toISOString() }),
              },
            );
            await sendTelegramMessage(
              `Video posted: ${video.id}\nPlatforms: ${platformsAttempted.join(', ')}\n${caption.slice(0, 100)}`,
            );
            console.log(`[cron-post-videos] Video ${video.id} posted successfully`);
            summary.posted.push(video.id);
          } else {
            const errorSummary = videoResults.filter((r) => !r.ok).map((r) => `${r.platform}: ${r.error}`).join('; ');
            await supabaseFetch(
              `/rest/v1/video_library?id=eq.${encodeURIComponent(video.id)}`,
              {
                method: 'PATCH',
                headers: { Prefer: 'return=minimal' },
                body: JSON.stringify({ status: 'failed', posted_date: null }),
              },
            );
            await sendTelegramMessage(`Video post FAILED: ${video.id}\nErrors: ${errorSummary}`);
            console.error(`[cron-post-videos] Video ${video.id} failed:`, errorSummary);
          }
        }
      }
    }
  }

  // --- STEP 3: Post any video_approved skits to Zernio ---
  const skitPostResult = await postApprovedSkits();
  summary.skit_posted = skitPostResult.posted;

  return res.status(200).json({
    ok: libraryOk,
    video_id: videoId,
    platforms_attempted: platformsAttempted,
    results: videoResults,
    summary,
  });
};

// --- Skit video posting handler ---
// Called from this same cron run to post video_approved skits to Zernio.
// Skits post to Instagram + TikTok only (vertical 9:16 format).
const SKIT_PLATFORMS = ['instagram', 'tiktok'];

async function postApprovedSkits() {
  const { data: skitRows, ok: skitOk } = await supabaseFetch(
    '/rest/v1/skit_queue?status=eq.video_approved&order=created_at.asc&limit=1',
  );
  if (!skitOk || !Array.isArray(skitRows) || skitRows.length === 0) {
    return { posted: [], skipped: [] };
  }

  const skit = skitRows[0];
  const skitId = skit.id;
  const videoUrl = skit.video_url;
  const caption = skit.caption || '';
  const topic = skit.topic || skitId;

  if (!videoUrl) {
    console.warn(`[cron-post-videos] Skit ${skitId} is video_approved but has no video_url`);
    await sendTelegramMessage(`Skit pipeline: ${skitId} is video_approved but video_url is null`);
    return { posted: [], skipped: [skitId] };
  }

  if (!caption.trim()) {
    console.warn(`[cron-post-videos] Skit ${skitId} has empty caption — skipping`);
    await sendTelegramMessage(`Skit pipeline safety check: ${skitId} has empty caption`);
    await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'failed' }),
    });
    return { posted: [], skipped: [skitId] };
  }

  if (!ZERNIO_API_KEY) {
    return { posted: [], skipped: [skitId] };
  }

  // Soft lock
  await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}&status=eq.video_approved`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'posting' }),
  });

  const results = [];
  let allOk = true;
  for (const platform of SKIT_PLATFORMS) {
    const result = await postToZernio(platform, videoUrl, caption, topic);
    results.push({ platform, ...result });
    if (!result.ok) {
      allOk = false;
      console.error(`[cron-post-videos] Skit ${skitId} failed on ${platform}:`, result.error);
    }
  }

  if (allOk) {
    await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'posted' }),
    });
    await sendTelegramMessage(`Reel posted: ${topic}\nPlatforms: ${SKIT_PLATFORMS.join(', ')}`);
    console.log(`[cron-post-videos] Skit ${skitId} posted`);
    return { posted: [skitId], skipped: [] };
  } else {
    const errorSummary = results.filter((r) => !r.ok).map((r) => `${r.platform}: ${r.error}`).join('; ');
    await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'failed' }),
    });
    await sendTelegramMessage(`Reel post FAILED: ${topic}\nErrors: ${errorSummary}`);
    return { posted: [], skipped: [skitId] };
  }
}
