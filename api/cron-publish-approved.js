// Vercel Serverless Function: /api/cron-publish-approved
// Picks up approved social_posts and pushes each one to Zernio for fan-out
// to the connected platform account.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — every 30 min ("*/30 * * * *").
//
// Behaviour:
//   1. For each platform with approved-and-due rows, look up today's
//      posting_schedule row (time_slots + max_per_day + max_per_slot).
//   2. Skip the platform until the next slot's clock-time has arrived
//      (compares now-in-platform-tz against time_slots).
//   3. Skip the platform once max_per_day is reached for today.
//   4. tiktok rows are flipped to status='pending_video' (Zernio rejects
//      text-only TikTok); they'll be picked up when a video is attached
//      via the DONE pipeline. TikTok is ACTIVE at 1/day (cap in posting_schedule).
//   5. Zernio errors land in social_posts.error_message and the row flips
//      to status='failed' (replaces the prior "leave at approved for retry"
//      behaviour, which silently masked permanent failures).
//
// Concurrency hardening (2026-05-06):
//   - Stuck-row recovery on entry: 'publishing' rows older than 10 min get
//     reverted to 'approved' so a crashed cron doesn't strand them.
//   - Soft lock per row: a conditional PATCH ?status=eq.approved flips the
//     row to 'publishing' BEFORE the Zernio call. If 0 rows affected, a
//     parallel run already grabbed it; we skip.
//   - Per-iteration cap recheck: countPostedToday is called inside the loop
//     immediately before each publish (no per-platform decision cache). This
//     fixes the bug where 3 posts went out under a max_per_day=1 cap because
//     all three saw the start-of-run snapshot.
//   - Content-hash dedup: skip if a post with the same content_hash already
//     hit the same platform in the last 24h.

const { retryFetch } = require('./_lib/retry.js');
const { DateTime } = require('luxon');
const { recordCronRun } = require('./_lib/cron-telemetry.js');
const { isPaused } = require('./_lib/paused-crons.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const ZERNIO_POSTS_URL = 'https://zernio.com/api/v1/posts';
const MAX_PER_RUN = 10; // bumped from 8 to 10 — 9 posts/day with YouTube added (2026-05-29)

// YouTube account ID is stored in env var — Heath must add ZERNIO_YOUTUBE_ACCOUNT_ID
// in Vercel dashboard (Settings -> Environment Variables). Value comes from Zernio
// dashboard under Connected Accounts -> YouTube -> Account ID.
const ZERNIO_YOUTUBE_ACCOUNT_ID = process.env.ZERNIO_YOUTUBE_ACCOUNT_ID || null;

// Twitter thread split with hard caps. Verified on the 838-char Brenda thread
// that previously exploded into 15 sub-fragments because the LLM had written
// bare "1/", "2/" markers as standalone paragraphs.
//   - Max 6 chunks per thread (truncates if overflow)
//   - Drop paragraphs <20 chars (kills bare "1/", "2/" numbering markers)
//   - Min 60 chars per chunk (merge backward into setup, fall back to forward)
//   - Paragraph-first split, sentence-fallback only for paragraphs >HARD_LIMIT
//   - When count >6, greedily merge the smallest adjacent pair
//   - No thread numbering — continuous replies only
const TWITTER_LIMIT = 280;
const TWITTER_HARD_LIMIT = TWITTER_LIMIT; // No numbering reserve needed
const TWITTER_MAX_CHUNKS = 6;
const TWITTER_MIN_CHUNK = 60;
const TWITTER_SKIP_BELOW = 20;

// Telegram notification helpers
async function sendTelegramNotification(text, buttons) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false };
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (buttons && buttons.length > 0) {
    body.reply_markup = { inline_keyboard: [buttons] };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ok: res.ok };
  } catch (err) {
    console.error('[telegram-notify] failed:', err && err.message);
    return { ok: false };
  }
}

async function sendPublishSummary(published, parkedTiktok, skipped, errors) {
  // Only notify when something actually happened. Skipped-only runs are noise
  // — they fire every 30 min as posts wait for their scheduled slot.
  if (published === 0 && parkedTiktok === 0 && errors.length === 0) return;

  const lines = ['📊 <b>PUBLISH SUMMARY</b>', ''];

  if (published > 0) {
    lines.push(`✅ <b>${published} posted successfully</b>`);
  }
  if (parkedTiktok > 0) {
    lines.push(`🎬 ${parkedTiktok} TikTok queued for video (DONE pipeline)`);
  }
  if (skipped > 0) {
    lines.push(`⏭️ ${skipped} skipped (schedule/cap/lock)`);
  }
  if (errors.length > 0) {
    lines.push(`\n❌ <b>${errors.length} FAILED</b>`);
  }

  await sendTelegramNotification(lines.join('\n'));
}

async function sendFailureAlert(post, errorMsg) {
  const preview = (post.content || '').substring(0, 60).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = [
    '🚨 <b>PUBLISH FAILED</b>',
    '',
    `<b>Platform:</b> ${post.platform}`,
    `<b>Persona:</b> ${post.persona || 'unknown'}`,
    `<b>Error:</b> ${errorMsg || 'unknown error'}`,
    '',
    `<b>Preview:</b> "${preview}..."`,
  ];

  const retryButton = {
    text: '🔄 Retry Now',
    callback_data: `retry_${post.id}`,
  };

  await sendTelegramNotification(lines.join('\n'), [retryButton]);
}

function splitForTwitter(body) {
  const text = String(body || '').trim();
  if (!text) return [];
  if (text.length <= TWITTER_LIMIT) return [text];

  // 1. Paragraph split, drop bare-numbering markers ("1/", "2/", etc.).
  let paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  paragraphs = paragraphs.filter((p) => p.length >= TWITTER_SKIP_BELOW);

  // 2. Any paragraph longer than HARD_LIMIT splits on sentence boundaries.
  const splitLong = [];
  for (const para of paragraphs) {
    if (para.length <= TWITTER_HARD_LIMIT) { splitLong.push(para); continue; }
    const sentences = para.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [para];
    let cur = '';
    for (const raw of sentences) {
      const s = raw.trim();
      if (!s) continue;
      const cand = cur ? cur + ' ' + s : s;
      if (cand.length <= TWITTER_HARD_LIMIT) { cur = cand; continue; }
      if (cur) splitLong.push(cur);
      cur = s;
    }
    if (cur) splitLong.push(cur);
  }
  paragraphs = splitLong;

  // 3. Merge any chunk below MIN_CHUNK — prefer backward (punchlines stick to
  //    their setup), fall back to forward.
  const merged = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const cur = paragraphs[i];
    if (cur.length < TWITTER_MIN_CHUNK) {
      if (merged.length > 0) {
        const back = merged[merged.length - 1] + ' ' + cur;
        if (back.length <= TWITTER_HARD_LIMIT) {
          merged[merged.length - 1] = back;
          continue;
        }
      }
      if (i + 1 < paragraphs.length) {
        const fwd = cur + ' ' + paragraphs[i + 1];
        if (fwd.length <= TWITTER_HARD_LIMIT) {
          paragraphs[i + 1] = fwd;
          continue;
        }
      }
    }
    merged.push(cur);
  }
  paragraphs = merged;

  // 4. While count > MAX_CHUNKS, greedily merge the smallest adjacent pair
  //    (whose combined size still fits HARD_LIMIT).
  while (paragraphs.length > TWITTER_MAX_CHUNKS) {
    let bestIdx = -1;
    let bestSum = Infinity;
    for (let i = 0; i < paragraphs.length - 1; i++) {
      const sum = paragraphs[i].length + 1 + paragraphs[i + 1].length;
      if (sum <= TWITTER_HARD_LIMIT && sum < bestSum) {
        bestSum = sum;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break; // nothing more can be merged without overflow
    paragraphs[bestIdx] = paragraphs[bestIdx] + ' ' + paragraphs[bestIdx + 1];
    paragraphs.splice(bestIdx + 1, 1);
  }

  // Defensive cap — should rarely fire after step 4.
  if (paragraphs.length > TWITTER_MAX_CHUNKS) {
    console.warn(`[twitter-split] WARN truncating ${paragraphs.length} chunks to ${TWITTER_MAX_CHUNKS} — content too large to merge cleanly`);
    paragraphs = paragraphs.slice(0, TWITTER_MAX_CHUNKS);
  }

  // Return chunks as-is — no thread numbering
  for (const c of paragraphs) {
    if (c.length > TWITTER_LIMIT) {
      console.warn(`[twitter-split] WARN chunk exceeds ${TWITTER_LIMIT}: ${c.length} chars — ${c.slice(0, 60)}…`);
    }
  }
  return paragraphs;
}

// Map a media URL to the Zernio docs' mediaItems entry shape.
function inferMediaItem(url) {
  const u = String(url || '').toLowerCase();
  let type = 'image';
  if (/\.(mp4|mov|avi|webm|mkv)(?:$|\?)/i.test(u)) type = 'video';
  return { url, type };
}

// Belt-and-suspenders media backfill (Atlas 2026-07-11).
// Root cause: Phase 5/6 rollout introduced several post-seeding paths
// (remix_hook_v2, community_movement_v1, dossiesign_showcase_v1,
// competitor_remix) that write rows directly into social_posts without
// calling renderSocialCard(). cron-generate-posts.js (the only path that
// attaches HCTI cards) is paused at "0 0 1 1 *". Result: last 2 posted
// FB Page posts went out text-only, get crushed by algorithm.
//
// Fix strategy: intercept at the publisher — for image-card platforms
// (facebook, instagram), if media_url is still null when we reach the
// publish loop, render an HCTI card inline before calling Zernio.
// This handles ALL generator paths (present and future) without requiring
// each one to remember the HCTI step. Idempotent + safe: if the render
// fails, we PATCH the row to 'failed' with a diagnostic, don't publish
// text-only (algorithm penalty > temporary skip).
const IMAGE_CARD_PLATFORMS = new Set(['facebook', 'instagram']);

async function backfillMediaIfMissing(post) {
  if (!post || post.media_url) return { skipped: true, reason: 'media already attached' };
  if (!IMAGE_CARD_PLATFORMS.has(post.platform)) return { skipped: true, reason: 'not a card platform' };

  const payload = {
    platform: post.platform,
    hook: post.hook || String(post.content || '').split('\n')[0].slice(0, 120),
    content: String(post.content || '').slice(0, 400),
    persona: post.persona || 'dossie',
    post_id: post.post_id || post.id,
  };

  console.log(`[media-backfill] rendering card for ${post.id} (${post.platform})`);
  try {
    const cardRes = await retryFetch(
      'https://meetdossie.com/api/generate-card',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CRON_SECRET}`,
        },
        body: JSON.stringify(payload),
      },
      { name: 'media-backfill', maxAttempts: 2, baseDelay: 1500 }
    );
    const text = await cardRes.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!cardRes.ok || !data?.publicUrl) {
      const err = `generate-card ${cardRes.status}: ${text.slice(0, 300)}`;
      console.warn(`[media-backfill] failed for ${post.id}: ${err}`);
      return { ok: false, error: err };
    }
    // Persist the URL so we don't re-render if this row is picked up again.
    const patch = await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ media_url: data.publicUrl }),
    });
    if (!patch.ok) {
      console.warn(`[media-backfill] card rendered but DB patch failed for ${post.id}: status=${patch.status}`);
      // Still return ok — publish can proceed with the URL in memory.
    }
    post.media_url = data.publicUrl; // mutate in place so pushToZernio sees it
    console.log(`[media-backfill] ok ${post.id} → ${data.publicUrl}`);
    return { ok: true, publicUrl: data.publicUrl };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn(`[media-backfill] threw for ${post.id}: ${msg}`);
    return { ok: false, error: msg };
  }
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

// Append UTM parameters to all meetdossie.com links in the content so we can
// attribute traffic per platform. Idempotent — won't double-stamp if a link
// already has utm_source set. Hooks into buildPostBody so every Zernio
// publish call gets the same treatment regardless of platform.
function applyUtm(content, platform) {
  if (!content || !platform) return content;
  const campaign = 'organic';
  const re = /(https?:\/\/(?:www\.)?meetdossie\.com[^\s)<>\]"']*)/gi;
  return content.replace(re, (match) => {
    if (/[?&]utm_source=/i.test(match)) return match;
    const sep = match.includes('?') ? '&' : '?';
    return `${match}${sep}utm_source=${encodeURIComponent(platform)}&utm_medium=social&utm_campaign=${campaign}`;
  });
}

function buildPostBody(post) {
  const hashtags = Array.isArray(post.hashtags) ? post.hashtags : [];
  const tagLine = hashtags.length
    ? '\n\n' + hashtags.map((h) => `#${String(h).replace(/^#/, '')}`).join(' ')
    : '';
  const rawContent = String(post.content || '');
  const content = applyUtm(rawContent, post.platform);
  const text = /\B#\w/.test(content) ? content : `${content}${tagLine}`;
  return text.trim();
}

// Fallback account lookup — Phase 5/6 seeders sometimes ship rows without
// zernio_account_id populated. Query zernio_accounts by platform + is_active.
async function lookupZernioAccountId(platform) {
  try {
    const { data, ok } = await supabaseFetch(
      `/rest/v1/zernio_accounts?platform=eq.${encodeURIComponent(platform)}&is_active=eq.true&select=zernio_account_id&limit=1`
    );
    if (ok && Array.isArray(data) && data.length > 0) return data[0].zernio_account_id || null;
  } catch (_) { /* swallow */ }
  return null;
}

async function pushToZernio(post) {
  if (!post.zernio_account_id) {
    // Try inline fallback lookup before failing (Atlas 2026-07-11).
    const fallback = await lookupZernioAccountId(post.platform);
    if (fallback) {
      console.log(`[zernio-account-fallback] post ${post.id} (${post.platform}): using ${fallback} from zernio_accounts table`);
      post.zernio_account_id = fallback;
    } else {
      return { ok: false, error: 'no zernio_account_id on row (and no fallback in zernio_accounts)' };
    }
  }
  const text = buildPostBody(post);

  // Real Zernio schema (per docs.zernio.com/platforms/{twitter,instagram}):
  //   { content, mediaItems[], platforms[{platform, accountId, platformSpecificData}], publishNow|scheduledFor }
  // CRITICAL: publishNow: true must be set, otherwise Zernio holds the post
  // as a draft on its end (and our cron sees a 200 success while the post
  // never actually goes live). For twitter threads, threadItems lives at
  // platforms[0].platformSpecificData.threadItems and the top-level content
  // is "for display and search purposes" only — the first tweet must also
  // be in threadItems[0].
  const platformBlock = {
    platform: post.platform,
    accountId: post.zernio_account_id,
  };

  let topContent = text;
  let topMediaItems;
  if (post.media_url) {
    topMediaItems = [inferMediaItem(post.media_url)];
  }

  if (post.platform === 'twitter') {
    const chunks = splitForTwitter(text);
    if (chunks.length > 1) {
      const items = chunks.map((c, i) => {
        const item = { content: c };
        // Attach media (if any) only to the first tweet of the thread.
        if (i === 0 && topMediaItems) item.mediaItems = topMediaItems;
        return item;
      });
      platformBlock.platformSpecificData = { threadItems: items };
      topContent = chunks[0]; // top-level content is display-only per docs
      topMediaItems = undefined; // already on threadItems[0], don't double-attach
      console.log(`[twitter-split] post ${post.id}: ${chunks.length} chunks (lengths ${chunks.map((c) => c.length).join(',')})`);
    } else if (chunks.length === 1) {
      topContent = chunks[0];
    }
  }

  // YouTube requires a title in platformSpecificData.
  // Use the hook field (already trimmed to <= 8 words) as the video title,
  // fall back to first line of caption. Strip special chars Zernio may reject.
  if (post.platform === 'youtube') {
    const rawTitle = post.hook || text.split('\n')[0] || 'Dossie - AI Transaction Coordinator for Texas Agents';
    platformBlock.platformSpecificData = {
      title: String(rawTitle).replace(/[^\w\s\-.,!?'"()&]/g, '').slice(0, 100).trim(),
    };
  }

  const payload = {
    content: topContent,
    platforms: [platformBlock],
  };
  if (topMediaItems) payload.mediaItems = topMediaItems;
  if (post.scheduled_for) {
    payload.scheduledFor = post.scheduled_for;
  } else {
    payload.publishNow = true;
  }

  // Log request payload for debugging
  console.log(`[zernio-request] post ${post.id} (${post.platform}):`, JSON.stringify(payload));

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
      { name: 'Zernio', maxAttempts: 3, baseDelay: 2000 }
    );
    const respText = await res.text();
    let data = null;
    try { data = respText ? JSON.parse(respText) : null; } catch { data = null; }

    // Log response for debugging
    console.log(`[zernio-response] post ${post.id} (${post.platform}): status=${res.status}, body=${respText.slice(0, 500)}`);

    if (!res.ok) {
      const errorMsg = `Zernio API ${res.status}: ${respText.slice(0, 500)}`;
      console.error(`[zernio-error] post ${post.id} (${post.platform}):`, errorMsg);
      return {
        ok: false,
        status: res.status,
        error: errorMsg,
        data,
      };
    }
    // Extract Zernio post ID — try ALL known field paths. 2026-06-06 regression
    // had new shape: { post: { _id, platforms: [ { _id, ... } ] } }.
    // Documented response shapes seen so far:
    //   { id, ... }
    //   { post_id, ... }
    //   { data: { id, ... } }
    //   { data: { postId, ... } }
    //   { posts: [ { id, platform, ... } ] }   ← multi-platform fan-out
    //   { results: [ { id, platform, ... } ] }
    //   { post: { _id, platforms: [ { _id, ... } ] } }   ← 2026-06-06 NEW SHAPE
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
      // FIX #3: post-survival verification — when Zernio says 2xx but gives us
      // no post_id back, the post may have silently failed validation on
      // their side (today's empty-zernio_post_id wave). Flag it so the
      // watchdog AND the morning digest treat it as unverified, not
      // counted-as-posted.
      console.warn(`[zernio-post-id] post ${post.id} (${post.platform}): NO post_id in 2xx response — treating as unverified. Full response: ${respText.slice(0, 600)}`);
      return { ok: true, status: res.status, data, zernio_post_id: null, unverified: true };
    }
    console.log(`[zernio-post-id] post ${post.id} (${post.platform}): captured zernio_post_id=${zernioPostId}`);
    return { ok: true, status: res.status, data, zernio_post_id: zernioPostId };
  } catch (err) {
    const errorMsg = err && err.message ? `Zernio exception: ${err.message}` : 'No response from Zernio';
    console.error(`[zernio-exception] post ${post.id} (${post.platform}):`, errorMsg);
    return { ok: false, error: errorMsg };
  }
}

// ─── posting_schedule helpers ────────────────────────────────────────────

// Compute today's clock state in the schedule row's timezone.
//   returns { dow: 0-6 Sun..Sat, hhmm: 'HH:MM', dateKey: 'YYYY-MM-DD' }
function nowInTz(tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
  );
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dow: dowMap[parts.weekday] ?? 0,
    hhmm: `${parts.hour}:${parts.minute}`,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

// Convert "HH:MM:SS" or "HH:MM" → minutes-since-midnight.
function hhmmToMin(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
}

async function loadSchedules() {
  const { data, ok } = await supabaseFetch('/rest/v1/posting_schedule?is_active=eq.true&select=platform,day_of_week,time_slots,timezone,max_per_day,max_per_slot');
  if (!ok) return [];
  return Array.isArray(data) ? data : [];
}

// Count how many posts have been published (or are being published right now) for
// `platform` today (in the platform tz).
//
// BUG FIX (2026-05-29): Previously only counted status='posted'. This caused a
// race condition within a single cron run: when post A was being sent to Zernio
// (status='publishing'), post B's cap check saw 0 'posted' rows and slipped through,
// resulting in 2+ LinkedIn posts firing in the same 30-min window. The fix counts
// BOTH 'posted' AND 'publishing' rows so in-flight publishes block concurrent ones.
//
// We use posted_at for 'posted' rows (accurate timestamp) and created_at as a proxy
// for 'publishing' rows (publishing_started_at column exists but the check against
// today's date range on created_at is fine — these are same-day rows by definition).
async function countPostedToday(platform, tz) {
  // Use luxon for proper timezone handling with automatic DST support.
  const now = DateTime.now().setZone(tz);
  const startOfDay = now.startOf('day').toUTC().toJSDate();
  const endOfDay = now.endOf('day').toUTC().toJSDate();

  const startOfDayUtc = startOfDay.toISOString();
  const endOfDayUtc = endOfDay.toISOString();

  console.log(`[countPostedToday] ${platform} in ${tz}: checking ${startOfDayUtc} to ${endOfDayUtc}`);

  // Count 'posted' rows: use posted_at timestamp (accurate).
  const postedFilter = `platform=eq.${encodeURIComponent(platform)}&status=eq.posted` +
    `&posted_at=gte.${encodeURIComponent(startOfDayUtc)}` +
    `&posted_at=lte.${encodeURIComponent(endOfDayUtc)}` +
    `&select=id,post_id,posted_at`;
  const { data: postedData, ok: postedOk } = await supabaseFetch(`/rest/v1/social_posts?${postedFilter}`);
  const postedCount = postedOk && Array.isArray(postedData) ? postedData.length : 0;

  // Count 'publishing' rows: use publishing_started_at timestamp (set when lock acquired).
  // This catches posts currently in-flight during this cron run so the cap blocks them.
  const publishingFilter = `platform=eq.${encodeURIComponent(platform)}&status=eq.publishing` +
    `&publishing_started_at=gte.${encodeURIComponent(startOfDayUtc)}` +
    `&publishing_started_at=lte.${encodeURIComponent(endOfDayUtc)}` +
    `&select=id,post_id,publishing_started_at`;
  const { data: publishingData, ok: publishingOk } = await supabaseFetch(`/rest/v1/social_posts?${publishingFilter}`);
  const publishingCount = publishingOk && Array.isArray(publishingData) ? publishingData.length : 0;

  const count = postedCount + publishingCount;
  if (count > 0) {
    const postedIds = postedOk && Array.isArray(postedData) ? postedData.map(p => `${p.post_id}(posted)`) : [];
    const publishingIds = publishingOk && Array.isArray(publishingData) ? publishingData.map(p => `${p.post_id}(publishing)`) : [];
    console.log(`[countPostedToday] ${platform}: found ${count} (${postedCount} posted + ${publishingCount} publishing):`, [...postedIds, ...publishingIds].join(', '));
  }
  return count;
}

// Decide if `platform` should publish right now: needs schedule row,
// current time >= some slot, daily cap not exhausted.
// Called per-iteration (no caching) so the cap reflects rows freshly posted
// earlier in the same cron run.
async function isDueForPublish(platform, schedules) {
  // Filter by platform AND current day of week
  const tz = 'America/Chicago'; // Default timezone for day calculation
  const today = nowInTz(tz);
  const row = schedules.find((s) => s.platform === platform && s.day_of_week === today.dow);
  // BUG FIX (2026-05-29): Previously returned due:true (uncapped publish) when no
  // schedule row existed for this platform+day combo. That let stale approved rows
  // fire on days they shouldn't publish (e.g. a Sunday row with no schedule entry
  // published immediately). Correct behaviour: no schedule = do not publish today.
  if (!row) return { due: false, reason: `no schedule row for ${platform} on day ${today.dow} — skipping` };

  const slots = (row.time_slots || []).map(hhmmToMin).sort((a, b) => a - b);
  const nowMin = hhmmToMin(today.hhmm);
  const passedSlots = slots.filter((s) => s <= nowMin);
  if (passedSlots.length === 0) {
    return { due: false, reason: `no slot reached yet (now=${today.hhmm}, next=${slots[0] != null ? Math.floor(slots[0]/60).toString().padStart(2,'0')+':'+(slots[0]%60).toString().padStart(2,'0') : 'none'})` };
  }

  const cap = row.max_per_day ?? null;
  if (cap != null) {
    const already = await countPostedToday(platform, tz);
    if (already >= cap) {
      return { due: false, reason: `daily cap reached (${already}/${cap})` };
    }
  }
  return { due: true, reason: `slot ${passedSlots[passedSlots.length - 1]} passed` };
}

// Soft lock: atomically flip status approved→publishing for this row.
// PostgREST's `?id=eq.X&status=eq.approved` filter scopes the PATCH so only
// rows still in 'approved' state are affected. Returns true if WE acquired
// the lock; false if another instance grabbed it (or the row moved out of
// 'approved' some other way) so the caller skips publishing.
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

// ─── orphan-schedule backfill ─────────────────────────────────────────────
// Ridge Watchdog SV-ENG-RIDGE-DIAGNOSTIC-001 raises `data.approved-no-schedule`
// (critical) when any row is status='approved' AND scheduled_for IS NULL. Such
// rows technically match the publish filter (line 699), but they fall to the
// end of the queue via nullslast + get starved by MAX_PER_RUN. This function
// assigns a fresh scheduled_for on the fly so the row exits the alert cohort
// AND publishes on schedule.
//
// Slot policy (fallback when posting_schedule is empty):
//   - 9am / 1pm / 5pm CT — matches human-preferred posting windows
//   - Round-robin across next 7 days by platform
//   - Cap 2 orphan-backfills per platform per day (avoids burst)
//
// Owner: Atlas 2026-07-11 (Ridge Watchdog Bug 2 fix).
const FALLBACK_SLOTS_CT = ['09:00', '13:00', '17:00'];
const FALLBACK_MAX_PER_PLATFORM_PER_DAY = 2;

async function assignFreshScheduleForOrphans() {
  const { data: orphans, ok } = await supabaseFetch(
    '/rest/v1/social_posts?select=id,platform,created_at&status=eq.approved&scheduled_for=is.null&order=created_at.asc&limit=50'
  );
  if (!ok || !Array.isArray(orphans) || orphans.length === 0) return { assigned: 0 };

  const schedules = await loadSchedules(); // empty array is fine
  const now = DateTime.now().setZone('America/Chicago');

  // Per-platform slot cursor: how many orphans we've already assigned to each
  // platform in this run (starts at 0). Combined with count-of-existing-approved
  // rows per platform per day, we avoid stacking too many into any one day.
  const platformCursor = {};

  const assignments = [];

  for (const orphan of orphans) {
    const platform = orphan.platform || 'twitter';
    if (!platformCursor[platform]) platformCursor[platform] = 0;

    // Try to find a slot from posting_schedule for this platform first.
    // If none exist (current state — Ridge Bug 2 root cause), use fallback slots.
    let scheduledFor = null;

    // Search next 7 days for the first available slot on this platform.
    for (let dayOffset = 0; dayOffset < 7 && !scheduledFor; dayOffset++) {
      const candidateDay = now.plus({ days: dayOffset });
      const dow = candidateDay.weekday % 7; // luxon: Mon=1..Sun=7, we want Sun=0..Sat=6
      const dowIndex = dow === 7 ? 0 : dow;

      const scheduleRow = schedules.find((s) => s.platform === platform && s.day_of_week === dowIndex);
      const slots = scheduleRow && Array.isArray(scheduleRow.time_slots) && scheduleRow.time_slots.length > 0
        ? scheduleRow.time_slots.map((t) => String(t).slice(0, 5)).sort()
        : FALLBACK_SLOTS_CT;

      for (const slot of slots) {
        const [h, m] = slot.split(':').map(Number);
        const candidate = candidateDay.set({ hour: h, minute: m, second: 0, millisecond: 0 });
        // Must be strictly in the future by at least 5 min
        if (candidate.diffNow('minutes').minutes < 5) continue;

        // Cap orphan-backfills per platform per day (avoid burst).
        const dayKey = `${platform}|${candidate.toISODate()}`;
        const alreadyAssignedThisRun = assignments.filter(a => a.dayKey === dayKey).length;
        if (alreadyAssignedThisRun >= FALLBACK_MAX_PER_PLATFORM_PER_DAY) continue;

        scheduledFor = candidate.toUTC().toISO();
        assignments.push({ id: orphan.id, platform, scheduledFor, dayKey });
        break;
      }
    }

    if (!scheduledFor) {
      // Should be unreachable given 7-day window × 3 slots × 2 posts/platform/day = 42 capacity.
      console.warn(`[orphan-schedule] could not slot orphan ${orphan.id} (${platform}) — falling back to now+1h`);
      const fallback = now.plus({ hours: 1 }).toUTC().toISO();
      assignments.push({ id: orphan.id, platform, scheduledFor: fallback, dayKey: `${platform}|fallback` });
    }
  }

  // PATCH each row. Conditional filter `status=eq.approved&scheduled_for=is.null`
  // prevents overwriting if state changed between SELECT + PATCH.
  let assignedCount = 0;
  for (const a of assignments) {
    const res = await supabaseFetch(
      `/rest/v1/social_posts?id=eq.${encodeURIComponent(a.id)}&status=eq.approved&scheduled_for=is.null`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ scheduled_for: a.scheduledFor }),
      }
    );
    if (res.ok) {
      assignedCount++;
      console.log(`[orphan-schedule] assigned ${a.id} (${a.platform}) → ${a.scheduledFor}`);
    } else {
      console.warn(`[orphan-schedule] PATCH failed for ${a.id}: status=${res.status}`);
    }
  }

  if (assignedCount > 0) {
    console.log(`[orphan-schedule] backfilled ${assignedCount}/${orphans.length} orphan approved rows`);
  }
  return { assigned: assignedCount, total_orphans: orphans.length };
}

// Recover rows stuck in 'publishing' for >10 min. Either the cron crashed
// after the lock or the Zernio call hung. Returning to 'approved' lets the
// next run retry. Risk window: if a delayed Zernio call eventually
// succeeds, we may publish twice — but 10 min is well past Zernio's
// observed latency (<5s), so this is safe.
async function recoverStuckPublishing() {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const filter = `status=eq.publishing&publishing_started_at=lt.${encodeURIComponent(cutoff)}`;
  const res = await supabaseFetch(`/rest/v1/social_posts?${filter}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'approved', publishing_started_at: null }),
  });
  if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
    console.warn(`[cron-publish-approved] recovered ${res.data.length} stuck publishing rows`);
  }
}

// Skip if the same content has already hit this platform in the last 24h.
// Belt-and-suspenders against any Zernio-side or cron-side duplication that
// slips past the soft lock.
async function isDuplicateRecentPost(post) {
  if (!post.content_hash || !post.platform) return false;
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const filter = `platform=eq.${encodeURIComponent(post.platform)}` +
    `&status=eq.posted` +
    `&content_hash=eq.${encodeURIComponent(post.content_hash)}` +
    `&posted_at=gte.${encodeURIComponent(cutoff)}` +
    `&id=neq.${encodeURIComponent(post.id)}` +
    `&select=id&limit=1`;
  const { data, ok } = await supabaseFetch(`/rest/v1/social_posts?${filter}`);
  if (!ok) return false;
  return Array.isArray(data) && data.length > 0;
}

// ─── self-heal ───────────────────────────────────────────────────────────
// Vercel Hobby crons aren't guaranteed: a deploy in flight at the cron's
// trigger window can silently drop the invocation. The publish cron runs
// every 30 min (which the platform DOES tend to honour reliably for short
// jobs), so we use it as a safety net — if today's content_batches row is
// missing AND we're inside the daytime window, kick off the
// generate → send-for-approval chain inline. The publish cron's
// maxDuration is bumped to 120s in vercel.json to give us headroom for
// the ~55s generate call.

async function selfHealMissedBatch() {
  // Window: 11:30 UTC (30-min grace after the scheduled 11:00) through
  // 20:00 UTC. Past 20:00 we leave it alone — no point dropping drafts
  // into the approval bot at 3am Heath's local time if he was away.
  const now = new Date();
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (utcMins < 11 * 60 + 30 || utcMins >= 20 * 60) return;

  const todayStartUtc = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
  )).toISOString();

  const checkResp = await fetch(
    `${SUPABASE_URL}/rest/v1/content_batches?generated_at=gte.${encodeURIComponent(todayStartUtc)}&select=id&limit=1`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    },
  );
  if (!checkResp.ok) {
    console.warn('[self-heal] content_batches check failed:', checkResp.status);
    return;
  }
  const rows = await checkResp.json().catch(() => []);
  if (Array.isArray(rows) && rows.length > 0) return; // batch exists, no heal needed

  // 2026-07-04 (Atlas) — PAUSE-AWARE GUARD.
  // Self-heal used to unconditionally fire cron-generate-posts +
  // cron-send-for-approval when no daily batch was present. Both live at the
  // cost-freeze schedule '0 0 1 1 *' today, so this path was silently burning
  // Anthropic $ every 30-minute publish tick. Bail early if either target is
  // paused — the batch will stay missing (intentionally, freeze is on).
  if (isPaused('/api/cron-generate-posts') || isPaused('/api/cron-send-for-approval')) {
    console.log('[self-heal] skipped — generate-posts or send-for-approval is paused (cost freeze)');
    return;
  }

  console.log(`[self-heal] no batch for today (${todayStartUtc}) AND in 11:30–20:00 UTC window — triggering generate + send`);

  try {
    const genResp = await retryFetch(
      'https://meetdossie.com/api/cron-generate-posts',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      },
      { name: 'self-heal-generate', maxAttempts: 3, baseDelay: 2000 }
    );
    const genText = await genResp.text();
    console.log(`[self-heal] generate status=${genResp.status} body=${genText.slice(0, 200)}`);
    if (!genResp.ok) {
      console.error('[self-heal] generate failed — skipping send');
      return;
    }
  } catch (err) {
    console.error('[self-heal] generate threw:', err && err.message);
    return;
  }

  try {
    const sendResp = await retryFetch(
      'https://meetdossie.com/api/cron-send-for-approval',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      },
      { name: 'self-heal-send', maxAttempts: 3, baseDelay: 2000 }
    );
    const sendText = await sendResp.text();
    console.log(`[self-heal] send status=${sendResp.status} body=${sendText.slice(0, 200)}`);
  } catch (err) {
    console.error('[self-heal] send threw:', err && err.message);
  }

  console.log(`[self-heal] healed missed daily batch at ${now.toISOString()}`);
}

// ─── main ────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // Auth: accept EITHER Vercel's built-in cron header OR manual Bearer token
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
    console.error('[cron-publish-approved] ZERNIO_API_KEY not configured — skipping run.');
    await recordCronRun('cron-publish-approved', 'skipped', { reason: 'zernio not configured' });
    return res.status(200).json({ ok: true, skipped: true, reason: 'zernio not configured' });
  }

  try {
    // Recover any rows stuck in 'publishing' from a crashed prior run.
    await recoverStuckPublishing();

    // Ridge Watchdog Bug 2 fix (2026-07-11): backfill scheduled_for on any
    // status='approved' AND scheduled_for IS NULL rows so they don't sit
    // forever at the tail of the queue. Ridge's data.approved-no-schedule
    // check goes GREEN once this runs.
    try {
      await assignFreshScheduleForOrphans();
    } catch (err) {
      console.error('[orphan-schedule] uncaught error:', err && err.message);
    }

    // Self-heal: if today's daily batch never landed (Vercel missed the trigger),
    // kick generate + send before we look for approved-and-due rows. Wrapped so
    // any failure is logged and we still publish whatever's already approved.
    try {
      await selfHealMissedBatch();
    } catch (err) {
      console.error('[self-heal] uncaught error:', err && err.message);
    }

    const nowIso = new Date().toISOString();
    const filter = `status=eq.approved&posted_at=is.null&or=(scheduled_for.is.null,scheduled_for.lte.${encodeURIComponent(nowIso)})`;
    const { data: items, ok: loadOk } = await supabaseFetch(
      `/rest/v1/social_posts?${filter}&order=approved_at.asc.nullslast&limit=${MAX_PER_RUN}`,
    );
    if (!loadOk) {
    return res.status(502).json({ ok: false, error: 'failed to load approved posts' });
  }
  const queue = Array.isArray(items) ? items : [];
  console.log('[cron-publish-approved] approved-and-due rows:', queue.length);

  const schedules = await loadSchedules();

  let published = 0;
  let skippedSchedule = 0;
  let skippedDuplicate = 0;
  let skippedLock = 0;
  let parkedTiktok = 0;
  const errors = [];
  const skips = [];

  for (const post of queue) {
    if (!post || !post.id) continue;

    // TikTok text-only → park for video pipeline.
    // FIX (Sage, 2026-06-12, Bug 7): only park when media_url is null. If a
    // tutorial-reel video is already attached at generation time (the Sage
    // reel build path that lands media_url='videos/tutorials/reels/...'),
    // let the normal Zernio publish flow handle it like any other post.
    if (post.platform === 'tiktok' && !post.media_url) {
      const patch = await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'pending_video',
          error_message: 'TikTok requires a video attachment; awaiting DONE-pipeline render.',
        }),
      });
      if (patch.ok) {
        parkedTiktok++;
        // Notify Heath to record and send DONE
        const topic = post.topic || 'unknown';
        const persona = post.persona || 'unknown';
        await sendTelegramNotification(
          `TikTok post queued - send DONE after recording to publish.\nTopic: ${topic}\nPersona: ${persona}`,
        );
      } else {
        errors.push({ id: post.id, error: 'patch to pending_video failed', status: patch.status });
      }
      continue;
    }

    // Schedule gate (time slot + daily cap). Re-evaluated PER ITERATION so
    // posts published earlier in this run count toward the cap. No caching.
    const decision = await isDueForPublish(post.platform, schedules);
    if (!decision.due) {
      skippedSchedule++;
      skips.push({ id: post.id, platform: post.platform, reason: decision.reason });
      continue;
    }

    // Content-hash dedup: if we already posted this exact content to this
    // platform in the last 24h, refuse to publish a duplicate.
    if (await isDuplicateRecentPost(post)) {
      skippedDuplicate++;
      skips.push({ id: post.id, platform: post.platform, reason: 'duplicate content_hash within 24h' });
      // Mark the row as failed so it doesn't keep showing up in the queue.
      console.error(`[cron-publish-approved] MARKING FAILED: post ${post.id} (${post.platform}) - duplicate content_hash within 24h`);
      await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'failed',
          error_message: 'duplicate content_hash within 24h — refused to republish',
        }),
      });
      continue;
    }

    // Soft lock: atomically grab the row before calling Zernio. If another
    // cron instance already acquired it, skip — the published row will be
    // patched by the winner.
    const acquired = await tryAcquirePublishLock(post.id);
    if (!acquired) {
      skippedLock++;
      skips.push({ id: post.id, platform: post.platform, reason: 'lock not acquired (parallel run?)' });
      continue;
    }

    // Media gate: block publish if the post requires a video/image that hasn't been attached yet.
    // video_required is set per-platform in cron-generate-posts: true for tiktok/youtube only.
    // Instagram now uses HCTI image cards (media_url set at generation time) — video_required=false.
    // Twitter, LinkedIn, Facebook, and Instagram all publish without this gate.
    const needsVideo = post.video_required === true;
    if (needsVideo && !post.media_url) {
      const blockReason = 'video_required=true but media_url is null — Creatomate pipeline must render and attach video before publish';
      console.error(`[cron-publish-approved] BLOCKING ${post.platform} post ${post.id} — ${blockReason}`);
      await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'pending_video',
          publishing_started_at: null,
          error_message: blockReason,
        }),
      });
      // Don't count as error — this is expected state while video renders
      skips.push({ id: post.id, platform: post.platform, reason: blockReason });
      continue;
    }

    // Belt-and-suspenders media gate for FB Page + IG (Atlas 2026-07-11).
    // Text-only posts get algorithmically crushed on Facebook Pages. If a
    // card-platform row reaches publish without media_url, render HCTI
    // inline. On render failure, DO NOT publish text-only — mark failed +
    // alert Heath so he can escalate to the generator owner.
    if (IMAGE_CARD_PLATFORMS.has(post.platform) && !post.media_url) {
      const bf = await backfillMediaIfMissing(post);
      if (!bf.skipped && !bf.ok) {
        const blockReason = `no media_url on ${post.platform} row + inline card render failed (${bf.error || 'unknown'}). Refusing to publish text-only to a card platform — algorithm penalty.`;
        console.error(`[cron-publish-approved] BLOCKING ${post.platform} post ${post.id} — ${blockReason}`);
        await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            status: 'failed',
            publishing_started_at: null,
            error_message: blockReason.slice(0, 500),
          }),
        });
        await sendFailureAlert(post, blockReason);
        errors.push({ id: post.id, platform: post.platform, error: 'media_backfill_failed' });
        continue;
      }
    }

    console.log(`[cron-publish-approved] Publishing post ${post.id} (${post.platform}, ${post.persona}) media_url=${post.media_url ? 'yes' : 'no'}`);

    let result;
    try {
      result = await pushToZernio(post);
      console.log(`[cron-publish-approved] pushToZernio result for ${post.id}:`, JSON.stringify(result).slice(0, 500));
    } catch (pushError) {
      console.error(`[cron-publish-approved] EXCEPTION in pushToZernio for ${post.id}:`, pushError);
      result = {
        ok: false,
        error: `Exception: ${pushError.message || String(pushError)}`,
        status: 'exception',
      };
    }

    if (result.ok) {
      // FIX #3 (Atlas 2026-06-11): if zernio_post_id is null even on a 2xx,
      // mark posted with an error_message flagging unverified. The watchdog
      // and morning digest both filter on zernio_post_id IS NOT NULL so an
      // unverified row will appear as "behind pace" and the watchdog will
      // route around. Don't auto-republish from this lane — that risks
      // double-posting if Zernio actually fired.
      const unverified = !!result.unverified || !result.zernio_post_id;
      const patch = await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'posted',
          posted_at: new Date().toISOString(),
          publishing_started_at: null,
          zernio_post_id: result.zernio_post_id,
          error_message: unverified ? 'Zernio returned 2xx but no post_id — unverified survival' : null,
        }),
      });
      if (patch.ok) {
        published++;
        if (unverified) {
          console.warn(`[cron-publish-approved] ⚠ Published ${post.id} (${post.platform}) BUT UNVERIFIED — Zernio gave no post_id`);
        } else {
          console.log(`[cron-publish-approved] ✅ Published ${post.id} successfully`);
        }
      } else {
        console.error(`[cron-publish-approved] Patch after publish failed for ${post.id}:`, patch.status, patch.text);
        errors.push({ id: post.id, error: 'patch after publish failed', status: patch.status });
      }
    } else {
      console.error('[cron-publish-approved] ❌ push failed for', post.id, 'Full result:', JSON.stringify(result));

      // Build detailed error message
      const errBody = result.error ? String(result.error).slice(0, 1500) : 'no error property';
      const errData = result.data ? JSON.stringify(result.data).slice(0, 500) : 'no data property';
      const errorMsg = `[${result.status || 'no-status'}] ${errBody} | data: ${errData}`;

      console.error(`[cron-publish-approved] MARKING FAILED: post ${post.id} (${post.platform})`);
      console.error(`[cron-publish-approved] Error message to save: "${errorMsg}"`);

      const patchBody = {
        status: 'failed',
        publishing_started_at: null,
        error_message: errorMsg,
      };

      console.log(`[cron-publish-approved] Patch body:`, JSON.stringify(patchBody));

      const patch = await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patchBody),
      });

      console.log(`[cron-publish-approved] Patch response for ${post.id}:`, {
        ok: patch.ok,
        status: patch.status,
        data: patch.data,
        text: patch.text?.slice(0, 200),
      });

      if (!patch.ok) {
        console.error(`[cron-publish-approved] CRITICAL: Failed to mark post ${post.id} as failed. PATCH status: ${patch.status}, text: ${patch.text}`);
      } else {
        console.log(`[cron-publish-approved] Successfully marked ${post.id} as failed with error_message`);
      }

      errors.push({
        id: post.id,
        platform: post.platform,
        zernio_status: result.status,
        zernio_error: errBody,
        patch_ok: patch.ok,
        error_message_saved: errorMsg,
      });

      // Send immediate failure alert
      await sendFailureAlert(post, errorMsg);
    }
  }

    console.log('[cron-publish-approved] done — published', published,
      'parked-tiktok:', parkedTiktok,
      'skipped(schedule):', skippedSchedule,
      'skipped(duplicate):', skippedDuplicate,
      'skipped(lock):', skippedLock,
      'errors:', errors.length);

    // Send publish summary
    const totalSkipped = skippedSchedule + skippedDuplicate + skippedLock;
    await sendPublishSummary(published, parkedTiktok, totalSkipped, errors);

    await recordCronRun('cron-publish-approved', 'ok', {
      published,
      parked_tiktok: parkedTiktok,
      errors: errors.length,
    });

    return res.status(200).json({
      ok: true,
      published,
      parked_tiktok: parkedTiktok,
      skipped_schedule: skippedSchedule,
      skipped_duplicate: skippedDuplicate,
      skipped_lock: skippedLock,
      attempted: queue.length,
      errors,
      skips,
    });
  } catch (e) {
    console.error('cron-publish-approved crashed:', e);
    await recordCronRun('cron-publish-approved', 'error', { error: e.message });
    return res.status(500).json({ ok: false, error: e.message });
  }
};
