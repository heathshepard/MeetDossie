// Vercel Serverless Function: /api/cron-post-videos
// Runs at 13:30 UTC (8:30am CT) daily — see vercel.json "30 13 * * *".
//
// SCHEDULE + CAP GATING (Carter 2026-09-07 — FEATURE-VIDEO-DAILY-PLAN §3):
//   Every platform posts through the live `posting_schedule` table:
//   - No schedule row for today, or row is_active=false  → platform skipped.
//   - Platform already at max_per_day (social_posts + video_library
//     posted today, America/Chicago day)                 → platform skipped.
//   - Otherwise the Zernio call targets the platform's next slot today
//     (scheduledFor); if every slot has already passed, it publishes now.
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

// Scheduled-Telegram kill switch (Atlas 2026-08-16). Gates unattended pushes
// to Heath behind TELEGRAM_CRON_NOTIFICATIONS. Two-way chat is unaffected.
require('./_lib/telegram-gate').install('cron-post-videos');

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { DateTime } = require('luxon');

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

// All posting_schedule rows use America/Chicago; day boundaries and slot
// times are computed in this zone (with per-row tz override if one appears).
const DEFAULT_TZ = 'America/Chicago';

// Load today's posting_schedule rows (ACTIVE AND INACTIVE — inactive rows
// must be visible so the caller can skip those platforms, not fall through
// to "no schedule" ambiguity). Returns Map platform -> row.
async function loadTodaySchedule() {
  const { data, ok } = await supabaseFetch(
    '/rest/v1/posting_schedule?select=platform,day_of_week,time_slots,timezone,is_active,max_per_day',
  );
  if (!ok || !Array.isArray(data)) return null; // null = query failed (fail closed upstream)
  const byPlatform = new Map();
  for (const row of data) {
    const dow = DateTime.now().setZone(row.timezone || DEFAULT_TZ).weekday % 7; // luxon: Mon=1..Sun=7 → Sun=0..Sat=6
    if (row.day_of_week === dow) byPlatform.set(row.platform, row);
  }
  return byPlatform;
}

// Count today's posts per platform (video + text), today = America/Chicago
// day. Counts social_posts in posted/publishing state plus video_library
// rows posted today (each such row counts 1 against every platform in its
// platforms array). Returns Map platform -> count, or null on query failure.
async function getPostCountsToday() {
  const now = DateTime.now().setZone(DEFAULT_TZ);
  const startIso = encodeURIComponent(now.startOf('day').toUTC().toISO());

  const { data: socialRows, ok: socialOk } = await supabaseFetch(
    `/rest/v1/social_posts?or=(and(status.eq.posted,posted_at.gte.${startIso}),and(status.eq.publishing,publishing_started_at.gte.${startIso}))&select=platform`,
  );
  const { data: videoRows, ok: videoOk } = await supabaseFetch(
    `/rest/v1/video_library?status=eq.posted&posted_date=gte.${startIso}&select=platforms`,
  );
  if (!socialOk || !videoOk) return null;

  const counts = new Map();
  const bump = (p) => counts.set(p, (counts.get(p) || 0) + 1);
  if (Array.isArray(socialRows)) socialRows.forEach((r) => r.platform && bump(r.platform));
  if (Array.isArray(videoRows)) {
    videoRows.forEach((r) => {
      if (Array.isArray(r.platforms)) r.platforms.forEach(bump);
    });
  }
  return counts;
}

// Gate decision for one platform: post or skip, and at what time.
// Returns { post: true, scheduledFor: iso|null } or { post: false, reason }.
// scheduledFor = next slot later today in the schedule tz; null = every slot
// already passed, publish immediately (slot-passed == due, matching
// cron-publish-approved semantics).
function gatePlatform(platform, scheduleByPlatform, counts) {
  const row = scheduleByPlatform.get(platform);
  if (!row) {
    return { post: false, reason: 'no posting_schedule row for today' };
  }
  if (!row.is_active) {
    return { post: false, reason: 'posting_schedule row is INACTIVE' };
  }
  const cap = row.max_per_day;
  const already = counts.get(platform) || 0;
  if (cap != null && already >= cap) {
    return { post: false, reason: `daily cap reached (${already}/${cap})` };
  }

  const tz = row.timezone || DEFAULT_TZ;
  const now = DateTime.now().setZone(tz);
  let scheduledFor = null;
  for (const slot of (row.time_slots || [])) {
    const [h, m] = String(slot).split(':').map(Number);
    const candidate = now.set({ hour: h || 0, minute: m || 0, second: 0, millisecond: 0 });
    if (candidate > now && (scheduledFor === null || candidate < scheduledFor)) {
      scheduledFor = candidate;
    }
  }
  return { post: true, scheduledFor: scheduledFor ? scheduledFor.toUTC().toISO() : null };
}

// Split a video's platform list into postable targets and skips, with logs.
function resolvePlatformTargets(label, platforms, scheduleByPlatform, counts) {
  const targets = []; // { platform, scheduledFor }
  const skipped = []; // { platform, reason }
  for (const platform of platforms) {
    const gate = gatePlatform(platform, scheduleByPlatform, counts);
    if (gate.post) {
      console.log(`[cron-post-videos] ${label}: ${platform} → ${gate.scheduledFor ? `scheduled for ${gate.scheduledFor}` : 'publish now (all slots passed)'}`);
      targets.push({ platform, scheduledFor: gate.scheduledFor });
    } else {
      console.log(`[cron-post-videos] ${label}: SKIPPING ${platform} — ${gate.reason}`);
      skipped.push({ platform, reason: gate.reason });
    }
  }
  return { targets, skipped };
}

// Facebook Page routing (ported from cron-publish-approved.js, Atlas
// 2026-08-18): pin the exact Page via platformSpecificData.pageId so the
// post never depends on whichever Page is toggled on Zernio's dashboard.
async function lookupZernioPageId(platform, owner = 'dossie') {
  try {
    const { data, ok } = await supabaseFetch(
      `/rest/v1/zernio_accounts?platform=eq.${encodeURIComponent(platform)}&owner=eq.${encodeURIComponent(owner)}&is_active=eq.true&select=page_id&limit=1`,
    );
    if (ok && Array.isArray(data) && data.length > 0) return data[0].page_id || null;
  } catch (_) { /* swallow — fall back to Zernio dashboard default */ }
  return null;
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

// opts.scheduledFor: ISO timestamp → Zernio schedules the post for that
// slot; null/absent → publishNow: true (required, else Zernio holds a
// draft while returning 200 — see cron-publish-approved.js).
async function postToZernio(platform, videoUrl, caption, topic, opts = {}) {
  const accountId = ZERNIO_ACCOUNTS[platform];
  if (!accountId) {
    return { ok: false, error: `No Zernio account ID for platform: ${platform}` };
  }

  const platformBlock = { platform, accountId };

  // Facebook: pin the exact Page (same fix as cron-publish-approved —
  // without pageId the post lands on whichever Page happens to be selected
  // on Zernio's dashboard toggle, which may be Heath's realtor Page).
  if (platform === 'facebook') {
    const pageId = await lookupZernioPageId('facebook', 'dossie');
    if (pageId) {
      platformBlock.platformSpecificData = { ...(platformBlock.platformSpecificData || {}), pageId };
    } else {
      console.warn('[cron-post-videos] facebook: no page_id in zernio_accounts — Zernio will use its dashboard-selected Page');
    }
  }

  // YouTube requires a title in platformSpecificData.
  // Use topic as title (max 100 chars), fall back to first line of caption.
  if (platform === 'youtube') {
    const rawTitle = topic || caption.split('\n')[0] || 'Dossie - AI Transaction Coordinator for Texas Agents';
    platformBlock.platformSpecificData = {
      ...(platformBlock.platformSpecificData || {}),
      title: rawTitle.replace(/[^\w\s\-.,!?'"()&]/g, '').slice(0, 100).trim(),
    };
  }

  const payload = {
    content: caption,
    mediaItems: [{ url: videoUrl, type: 'video' }],
    platforms: [platformBlock],
  };
  if (opts.scheduledFor) {
    payload.scheduledFor = opts.scheduledFor;
  } else {
    payload.publishNow = true;
  }

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
    // Extract Zernio post ID — all known response shapes (mirrors
    // cron-publish-approved.js, incl. the 2026-06-06 { post: { _id } } shape).
    const zernioPostId =
      data?.id ||
      data?.post_id ||
      data?.postId ||
      data?.post?._id ||
      data?.data?.id ||
      data?.data?.post_id ||
      data?.data?.postId ||
      (Array.isArray(data?.posts) && data.posts[0]?.id) ||
      (Array.isArray(data?.results) && data.results[0]?.id) ||
      (Array.isArray(data?.data?.posts) && data.data.posts[0]?.id) ||
      (data?.post?.platforms && Array.isArray(data.post.platforms) && data.post.platforms[0]?._id) ||
      null;
    if (!zernioPostId) {
      // A 2xx with no post id usually means Zernio silently rejected the
      // post (validation failure on their side). Don't report clean success.
      console.warn(`[cron-post-videos] Zernio ${platform}: 2xx but NO post id in response — treating as unverified. Body: ${text.slice(0, 500)}`);
      return { ok: true, data, zernio_post_id: null, unverified: true };
    }
    return { ok: true, data, zernio_post_id: zernioPostId };
  } catch (err) {
    return { ok: false, error: `Zernio exception: ${err && err.message}` };
  }
}

module.exports = withTelemetry('cron-post-videos', async function handler(req, res) {
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
        // Schedule + cap gate (2026-09-07). Fail CLOSED: if we can't read
        // the schedule or today's counts, we cannot prove a post is within
        // cap, so nothing posts this run (row stays heath_approved).
        const scheduleByPlatform = await loadTodaySchedule();
        const counts = scheduleByPlatform ? await getPostCountsToday() : null;

        if (!scheduleByPlatform || !counts) {
          console.error('[cron-post-videos] posting_schedule / post-count query failed — failing closed, not posting');
          libraryOk = false;
          summary.skipped.push({ id: video.id, reason: 'schedule/cap query failed — fail closed' });
        } else {
          const requested = (Array.isArray(video.platforms) && video.platforms.length > 0)
            ? video.platforms
            : DEFAULT_PLATFORMS;
          const { targets, skipped: platformSkips } = resolvePlatformTargets(
            `video ${video.id}`, requested, scheduleByPlatform, counts,
          );
          summary.platform_skips = platformSkips;

          if (targets.length === 0) {
            console.log(`[cron-post-videos] Video ${video.id}: no platform eligible today — leaving heath_approved for a later run`);
            summary.skipped.push({ id: video.id, reason: 'no eligible platform today', platform_skips: platformSkips });
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
              platformsAttempted = targets.map((t) => t.platform);
              const caption = video.caption || '';

              for (const t of targets) {
                const result = await postToZernio(
                  t.platform, video.supabase_url, caption, video.topic,
                  { scheduledFor: t.scheduledFor },
                );
                videoResults.push({ platform: t.platform, scheduledFor: t.scheduledFor, ...result });
                if (!result.ok) {
                  libraryOk = false;
                  console.error(`[cron-post-videos] Failed on ${t.platform}:`, result.error);
                } else {
                  console.log(`[cron-post-videos] ${t.platform} accepted (${t.scheduledFor ? `scheduled ${t.scheduledFor}` : 'publish now'})${result.unverified ? ' — UNVERIFIED (no post id)' : ''}`);
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
                const unverified = videoResults.filter((r) => r.unverified).map((r) => r.platform);
                const msgLines = [
                  `Video posted: ${video.id}`,
                  `Platforms: ${videoResults.map((r) => `${r.platform}${r.scheduledFor ? ` @ ${r.scheduledFor}` : ' (now)'}`).join(', ')}`,
                ];
                if (platformSkips.length) msgLines.push(`Skipped: ${platformSkips.map((s) => `${s.platform} (${s.reason})`).join(', ')}`);
                if (unverified.length) msgLines.push(`UNVERIFIED (Zernio returned no post id): ${unverified.join(', ')} — check Zernio dashboard`);
                msgLines.push(caption.slice(0, 100));
                await sendTelegramMessage(msgLines.join('\n'));
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
});

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

  // Schedule + cap gate — recomputed here (not shared with the main video)
  // so a video posted moments earlier in this same run counts against the
  // skit's caps. Fail closed on query failure.
  const scheduleByPlatform = await loadTodaySchedule();
  const counts = scheduleByPlatform ? await getPostCountsToday() : null;
  if (!scheduleByPlatform || !counts) {
    console.error(`[cron-post-videos] Skit ${skitId}: schedule/cap query failed — failing closed, not posting`);
    return { posted: [], skipped: [skitId] };
  }
  const { targets, skipped: platformSkips } = resolvePlatformTargets(
    `skit ${skitId}`, SKIT_PLATFORMS, scheduleByPlatform, counts,
  );
  if (targets.length === 0) {
    console.log(`[cron-post-videos] Skit ${skitId}: no platform eligible today (${platformSkips.map((s) => `${s.platform}: ${s.reason}`).join('; ')}) — leaving video_approved for a later run`);
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
  for (const t of targets) {
    const result = await postToZernio(t.platform, videoUrl, caption, topic, { scheduledFor: t.scheduledFor });
    results.push({ platform: t.platform, ...result });
    if (!result.ok) {
      allOk = false;
      console.error(`[cron-post-videos] Skit ${skitId} failed on ${t.platform}:`, result.error);
    }
  }

  if (allOk) {
    await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'posted' }),
    });
    await sendTelegramMessage(`Reel posted: ${topic}\nPlatforms: ${targets.map((t) => t.platform).join(', ')}${platformSkips.length ? `\nSkipped: ${platformSkips.map((s) => `${s.platform} (${s.reason})`).join(', ')}` : ''}`);
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
