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
//   3. Skip the platform once max_per_day is reached for today — a pending
//      video_library row (heath_approved / pending_heath_review, targeting
//      this platform+owner today) RESERVES part of that cap first, so a
//      video can never lose its slot to a text post that merely ran
//      earlier in the day (Carter 2026-10-01 — see api/_lib/
//      video-reservation.js for the mechanism and incident history).
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

// Scheduled-Telegram kill switch (Atlas 2026-08-16). Gates unattended pushes
// to Heath behind TELEGRAM_CRON_NOTIFICATIONS. Two-way chat is unaffected.
require('./_lib/telegram-gate').install('cron-publish-approved');

const { retryFetch } = require('./_lib/retry.js');
const { DateTime } = require('luxon');
const { recordCronRun } = require('./_lib/cron-telemetry.js');
const {
  effectiveLength, clampForTwitter, assertTwitterFits,
} = require('./_lib/twitter-length.js');
const { isPaused } = require('./_lib/paused-crons.js');
const { checkPost: sanitizerCheckPost } = require('./_lib/caption-sanitizer.js');
const { tagOutboundLinks } = require('./_lib/content-tag.js');
const { logAutonomousAction } = require('./_lib/ops-policy.js');
// VIDEO-PRIORITY RESERVATION (Carter, 2026-10-01) — see api/_lib/
// video-reservation.js file header for the full incident history and
// mechanism rationale. isDueForPublish() below uses this to refuse a text
// post's slot when a pending video needs it today.
const { countReservedForVideo } = require('./_lib/video-reservation.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const ZERNIO_POSTS_URL = 'https://zernio.com/api/v1/posts';
// Bumped 10 -> 30 (Atlas 2026-08-18). Root cause of the Nopalito realtor
// posts sitting unfired: the approved-and-due queue is ordered
// approved_at.asc with NO staleness filter, so long-permanently-stuck rows
// (e.g. 9 tiktok rows from 2026-07-08/09/10 wedged behind a 1/day cap that
// something else always claims first, plus linkedin_personal rows with no
// Tuesday schedule) fill every slot in a LIMIT 10 window on every single
// run, forever. Freshly-approved rows queued behind them never even reach
// isDueForPublish(). 30 comfortably covers the live backlog without
// materially increasing per-run Zernio call volume (skips are cheap; only
// truly-due rows publish). Doesn't fix the zombie rows themselves — flagged
// separately for cleanup.
const MAX_PER_RUN = 30;

// YouTube account routing is DB-driven, not env-driven — same pattern as
// the heath-realtor facebook/instagram rows. See lookupZernioAccountId()
// below and supabase/migrations/20260825_zernio_accounts_youtube_heath_realtor.sql
// for the "Shepard Real Estate Solutions" channel row
// (platform=youtube, owner=heath-realtor). A prior ZERNIO_YOUTUBE_ACCOUNT_ID
// env-var stub lived here but was never read by pushToZernio() — removed
// 2026-08-25 as dead/misleading code, not a functional change.

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

// LENGTH IS MEASURED WITH effectiveLength(), NOT .length (Atlas 2026-09-25).
//
// Two counters have to clear 280 and they disagree: Twitter counts a URL as
// 23 whatever its length, Zernio's pre-flight counts raw characters. The four
// "Tweet text is too long (306/310/312)" rejections on 09-22, 09-24 x2 and
// 09-25 were all Zernio's raw counter reading a body whose CTA link had
// ~120 characters of UTM parameters attached by buildPostBody(). Measuring
// with .length alone is what let every one of them through.
// See api/_lib/twitter-length.js.
function splitForTwitter(body) {
  const text = String(body || '').trim();
  if (!text) return [];
  if (effectiveLength(text) <= TWITTER_LIMIT) return [text];

  // 1. Paragraph split, drop bare-numbering markers ("1/", "2/", etc.).
  let paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  paragraphs = paragraphs.filter((p) => p.length >= TWITTER_SKIP_BELOW);

  // 2. Any paragraph longer than HARD_LIMIT splits on sentence boundaries.
  const splitLong = [];
  for (const para of paragraphs) {
    if (effectiveLength(para) <= TWITTER_HARD_LIMIT) { splitLong.push(para); continue; }

    // MASK URLS BEFORE THE SENTENCE SPLIT (Atlas 2026-09-25).
    //
    // The sentence regex below breaks on every '.', and buildPostBody()'s
    // tagged links are FULL OF dots:
    //
    //   meetdossie.com/signup?...&utm_content=dossie.twitter.video.a1b2c3d4.20260925
    //
    // Split naively, that one link becomes five "sentences", which then get
    // merged, reordered and partly dropped by steps 3 and 4 — the thread
    // ships with a mangled or missing CTA link. It is a separate defect from
    // the length one and it destroys the only clickable thing in the post.
    // Masking each URL to a dot-free token keeps it atomic through the split.
    // Sentinel is intentionally NOT space-delimited (Sage, 2026-09-28,
    // fixing a regression this same investigation found): the sentence
    // splitter below is greedy on \s+, so a space-delimited placeholder
    // (` URL0 `) gets its own leading space swallowed into the PRECEDING
    // sentence's trailing whitespace whenever the source text already had a
    // natural space on the other side of the URL (i.e. almost always) —
    // unmask() then never matches and the literal token "URL0" ships in the
    // post. `@@URL0@@` has no whitespace for \s+ to eat, so the sentence
    // boundary can't cut through it.
    const urlStore = [];
    const masked = para.replace(
      /\b(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<>"')\]]*)?/gi,
      (u) => { urlStore.push(u); return `@@URL${urlStore.length - 1}@@`; },
    );
    const unmask = (s) => s.replace(/@@URL(\d+)@@/g, (_, i) => urlStore[Number(i)]);

    const sentences = (masked.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [masked]).map(unmask);
    let cur = '';
    for (const raw of sentences) {
      const s = raw.trim();
      if (!s) continue;
      const cand = cur ? cur + ' ' + s : s;
      if (effectiveLength(cand) <= TWITTER_HARD_LIMIT) { cur = cand; continue; }
      if (cur) splitLong.push(cur);
      // THE BUG: `s` was pushed on the next iteration without ever being
      // re-measured, so a SINGLE sentence longer than the limit shipped
      // whole. The sentence carrying the UTM-tagged CTA link is exactly that
      // sentence — that is the 306/310/312. Clamp it here; a sentence that
      // cannot fit gets trimmed on a word boundary with its link intact
      // rather than rejected by the platform.
      cur = effectiveLength(s) <= TWITTER_HARD_LIMIT
        ? s
        : clampForTwitter(s, { limit: TWITTER_HARD_LIMIT }).text;
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
        if (effectiveLength(fwd) <= TWITTER_HARD_LIMIT) {
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
      const sum = effectiveLength(`${paragraphs[i]} ${paragraphs[i + 1]}`);
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

  // FINAL GUARANTEE — no chunk leaves this function over the limit.
  //
  // This used to be a console.warn and nothing else, which is precisely how
  // four rejections stacked up with nobody noticing (see
  // feedback_silent-failure-is-the-enemy). A warning that does not change the
  // outcome is not a check.
  const out = paragraphs.map((c) => {
    if (effectiveLength(c) <= TWITTER_LIMIT) return c;
    const fixed = clampForTwitter(c, { limit: TWITTER_LIMIT });
    console.warn(`[twitter-split] chunk was ${fixed.before} (limit ${TWITTER_LIMIT}) — clamped to ${fixed.after}${fixed.keptTrailingUrl ? ', CTA link preserved' : ''}`);
    return fixed.text;
  });

  const check = assertTwitterFits(out);
  if (!check.ok) {
    // Unreachable after the clamp above; if it ever fires the clamp itself is
    // broken and that must surface as an error, never as a silent send.
    throw new Error(`[twitter-split] chunks still over ${TWITTER_LIMIT} after clamping: ${JSON.stringify(check.over)}`);
  }
  return out;
}

// Map a media URL to the Zernio docs' mediaItems entry shape.
// .pdf/.ppt/.pptx/.doc/.docx -> 'document' (Sage, 2026-09-28): LinkedIn
// native document posts (docs.zernio.com/platforms/linkedin) need
// mediaItems: [{ type: 'document', url }] + platformSpecificData.documentTitle
// (added just below, in pushToZernio). Before this, any PDF media_url was
// silently sent as type: 'image', which Zernio's LinkedIn endpoint rejects.
function inferMediaItem(url) {
  const u = String(url || '').toLowerCase();
  let type = 'image';
  if (/\.(mp4|mov|avi|webm|mkv)(?:$|\?)/i.test(u)) type = 'video';
  else if (/\.(pdf|ppt|pptx|doc|docx)(?:$|\?)/i.test(u)) type = 'document';
  return { url, type };
}

// Video-first strategy for FB/IG (Atlas 2026-07-11 R2 — reversed from R1).
// R1 rendered HCTI cards inline for missing-media FB/IG rows. Heath killed
// that approach: video-first, no HCTI cards for FB/IG under any circumstance.
// If a card-platform row reaches publish without a video media_url, we hold
// the row (mark 'pending_video') and DO NOT publish. Text-only bleeds cost
// more than a temporary skip.
//
// Video rotation from the 14 MP4 library in Media/remix-videos/ is wired
// via the generator paths (not here) — this cron only enforces the gate.
//
// UPDATED 2026-09-09 (Heath, verbatim: "lets do the screen recording
// pipeline. if creatomate is out of credits" — 402 verified since 2026-06-30):
// Creatomate is dead, daily FB/IG/TikTok video duty now runs through
// Pipeline B (video_library -> cron-post-videos), which posts independently
// of social_posts. cron-generate-posts.js no longer sets video_required=true
// for facebook, so its daily text captions should flow instead of parking
// forever. Instagram stays in this set — the Graph API has no text-only
// feed post, so an IG row with no media genuinely cannot publish regardless
// of policy; it still holds until Pipeline B (or a future re-enable) gives
// it a video via video_required. Facebook has no such platform constraint —
// FB Page posts have always supported text-only, this set just enforced a
// stricter internal policy while Creatomate was alive.
const IMAGE_CARD_PLATFORMS = new Set(['instagram']);

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

// Append content-attribution params to every meetdossie.com link in the post
// so a click can be traced back to this exact row (see api/_lib/content-tag.js
// for the tag scheme + which platforms strip caption links entirely).
// Idempotent — won't double-stamp a link that already has utm_source.
//
// FIX (2026-09-17): the prior version required an "https?://" scheme prefix,
// but cron-generate-posts.js's cta_rule fields write the bare domain
// ("meetdossie.com/signup", no scheme) — the old regex silently matched
// nothing on the vast majority of real captions. content-tag.js's regex
// matches with or without a scheme.
//
// Brand comes from target_owner (defaults 'dossie'; the same pipeline also
// carries Heath's own listing marketing under target_owner='heath-realtor').
// Format is 'video' for every row today (the video-only hard gate above
// blocks anything without a real video attachment), derived rather than
// hardcoded so a future non-video format still tags correctly.
function buildPostBody(post) {
  const hashtags = Array.isArray(post.hashtags) ? post.hashtags : [];
  const tagLine = hashtags.length
    ? '\n\n' + hashtags.map((h) => `#${String(h).replace(/^#/, '')}`).join(' ')
    : '';
  const rawContent = String(post.content || '');
  const isVideo = !!post.media_url && inferMediaItem(post.media_url).type === 'video';
  const { text: tagged, tag, linked } = tagOutboundLinks(rawContent, {
    domain: 'meetdossie.com',
    brand: post.target_owner || 'dossie',
    platform: post.platform,
    format: isVideo ? 'video' : 'image',
    contentId: post.id,
    postedAt: new Date(),
  });
  const text = /\B#\w/.test(tagged) ? tagged : `${tagged}${tagLine}`;
  return { text: text.trim(), contentTag: tag, linked };
}

// Fallback account lookup — Phase 5/6 seeders sometimes ship rows without
// zernio_account_id populated. Query zernio_accounts by platform + is_active.
//
// `owner` disambiguates two destinations on the same platform (e.g. Dossie's
// Facebook Page vs Heath's personal realtor Facebook Page — see
// 20260817_zernio_accounts_owner.sql). Defaults to 'dossie', so every
// existing call site (cron-generate-posts.js, cron-coverage-check.js, and
// this file's own default-arg calls) keeps resolving exactly as before.
async function lookupZernioAccountId(platform, owner = 'dossie') {
  try {
    const { data, ok } = await supabaseFetch(
      `/rest/v1/zernio_accounts?platform=eq.${encodeURIComponent(platform)}&owner=eq.${encodeURIComponent(owner)}&is_active=eq.true&select=zernio_account_id&limit=1`
    );
    if (ok && Array.isArray(data) && data.length > 0) return data[0].zernio_account_id || null;
  } catch (_) { /* swallow */ }
  return null;
}

// Facebook Page routing (Atlas, 2026-08-18 — see
// 20260818_zernio_accounts_page_id.sql). MeetDossie's Page and Heath's
// personal realtor Page (@HeathShepardRealtor) are both reachable through
// the SAME zernio_account_id — Zernio disambiguates which Page a post
// lands on via platforms[].platformSpecificData.pageId, not via a second
// connected account. Look up the real Facebook Page ID for this post's
// target_owner so we always publish to the intended Page regardless of
// whatever Page happens to be selected on Zernio's dashboard toggle.
async function lookupZernioPageId(platform, owner = 'dossie') {
  try {
    const { data, ok } = await supabaseFetch(
      `/rest/v1/zernio_accounts?platform=eq.${encodeURIComponent(platform)}&owner=eq.${encodeURIComponent(owner)}&is_active=eq.true&select=page_id&limit=1`
    );
    if (ok && Array.isArray(data) && data.length > 0) return data[0].page_id || null;
  } catch (_) { /* swallow */ }
  return null;
}

async function pushToZernio(post) {
  if (!post.zernio_account_id) {
    // Try inline fallback lookup before failing (Atlas 2026-07-11).
    // target_owner comes from social_posts (default 'dossie' — see
    // 20260817_social_posts_target_owner.sql); most rows never set it.
    const fallback = await lookupZernioAccountId(post.platform, post.target_owner || 'dossie');
    if (fallback) {
      console.log(`[zernio-account-fallback] post ${post.id} (${post.platform}): using ${fallback} from zernio_accounts table`);
      post.zernio_account_id = fallback;
    } else {
      return { ok: false, error: 'no zernio_account_id on row (and no fallback in zernio_accounts)' };
    }
  }
  const { text, contentTag, linked } = buildPostBody(post);
  console.log(`[content-tag] post ${post.id} (${post.platform}, ${post.target_owner || 'dossie'}): tag=${contentTag} linked=${linked}`);

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

  // Facebook: pin the exact Page this post targets (see lookupZernioPageId
  // above). Covers both owners explicitly — dossie rows get MeetDossie's
  // own Page ID pinned too, so behavior no longer silently depends on
  // whichever Page happens to be selected on Zernio's dashboard toggle.
  if (post.platform === 'facebook') {
    const pageId = await lookupZernioPageId('facebook', post.target_owner || 'dossie');
    if (pageId) {
      platformBlock.platformSpecificData = { ...(platformBlock.platformSpecificData || {}), pageId };
      console.log(`[zernio-facebook-page] post ${post.id}: target_owner=${post.target_owner || 'dossie'} pageId=${pageId}`);
    } else {
      console.log(`[zernio-facebook-page] post ${post.id}: no page_id found for target_owner=${post.target_owner || 'dossie'} — Zernio will use its dashboard-selected Page`);
    }
  }

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

  // LinkedIn native document posts require documentTitle in
  // platformSpecificData (docs.zernio.com/platforms/linkedin) — the first
  // page of the PDF is the cover, but the carousel's title bar is this
  // field, not derived from the file. Only set for document media; a plain
  // LinkedIn image/video post has no such field.
  if (post.platform === 'linkedin' && topMediaItems && topMediaItems[0] && topMediaItems[0].type === 'document') {
    const rawTitle = post.hook || text.split('\n')[0] || 'TREC 20-19 Contract Changes';
    platformBlock.platformSpecificData = {
      ...(platformBlock.platformSpecificData || {}),
      documentTitle: String(rawTitle).replace(/[^\w\s\-.,!?'"()&]/g, '').slice(0, 100).trim(),
    };
  }

  // AI-disclosure label (Carter, 2026-09-16; fixed to read off content
  // 2026-09-17) — see the identical block in api/cron-post-videos.js
  // postToZernio() for the full rationale and field sourcing. This is the
  // other live path a video media_url can reach Zernio through
  // (social_posts.media_url). Was gated on owner==='heath-realtor' — a
  // proxy, not a fact, and one that could never flag Rust content even
  // though Heath's cloned voice is approved for Rust too
  // (heath-voice-clone-usage-scope.md). Reads social_posts.uses_cloned_voice
  // directly instead (20260917b_ai_disclosure_content_property.sql) — Rust
  // doesn't route through cron-generate-posts.js/social_posts today, but
  // the column exists so that isn't a reason it can't disclose correctly
  // once it does.
  const usesHeathClonedVoice = post.uses_cloned_voice === true;
  if (usesHeathClonedVoice && post.platform === 'youtube' && post.media_url) {
    platformBlock.platformSpecificData = {
      ...(platformBlock.platformSpecificData || {}),
      containsSyntheticMedia: true,
    };
  }
  if (usesHeathClonedVoice && post.platform === 'tiktok' && post.media_url) {
    // See cron-post-videos.js note: TikTok's other required tiktokSettings
    // fields aren't sent here either — pre-existing gap, not fixed here.
    platformBlock.platformSpecificData = {
      ...(platformBlock.platformSpecificData || {}),
      tiktokSettings: {
        ...((platformBlock.platformSpecificData && platformBlock.platformSpecificData.tiktokSettings) || {}),
        video_made_with_ai: true,
      },
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
      return { ok: true, status: res.status, data, zernio_post_id: null, unverified: true, content_tag: contentTag };
    }
    console.log(`[zernio-post-id] post ${post.id} (${post.platform}): captured zernio_post_id=${zernioPostId}`);
    return { ok: true, status: res.status, data, zernio_post_id: zernioPostId, content_tag: contentTag };
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

// Fetches ALL rows (active and inactive, every owner) — isDueForPublish()
// below picks the right one per (platform, day, owner) and checks is_active
// itself. Previously this filtered is_active=eq.true at the query, which
// meant an owner-specific override could never be seen if the SHARED row
// for that platform happened to be inactive (exactly Twitter/X's state for
// Dossie — see 20260916d_rust_owner_wiring.sql).
async function loadSchedules() {
  const { data, ok } = await supabaseFetch('/rest/v1/posting_schedule?select=platform,day_of_week,time_slots,timezone,is_active,max_per_day,max_per_slot,owner');
  if (!ok) return [];
  return Array.isArray(data) ? data : [];
}

// Resolve the schedule row for (platform, day, owner): an owner-specific
// override (owner = the exact value) takes precedence over the shared row
// (owner IS NULL) for that same platform+day. Mirrors cron-post-videos.js's
// loadTodaySchedule()/gatePlatform() (Carter 2026-09-16 — RUST-OWNER-WIRING).
function findScheduleRow(schedules, platform, dow, owner) {
  const rows = schedules.filter((s) => s.platform === platform && s.day_of_week === dow);
  return rows.find((s) => s.owner === owner) || rows.find((s) => !s.owner) || null;
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
// `owner` scopes the count to a single destination (e.g. 'dossie' vs
// 'heath-realtor') so two accounts on the SAME platform track independent
// daily caps against the shared posting_schedule slot/cap config. Without
// this, Heath's realtor Facebook page and Dossie's Facebook page shared one
// counter and one account's posts could exhaust the other's cap (Atlas
// 2026-08-18 — Nopalito realtor posts starved behind Dossie's own FB post).
async function countPostedToday(platform, tz, owner) {
  // Use luxon for proper timezone handling with automatic DST support.
  const now = DateTime.now().setZone(tz);
  const startOfDay = now.startOf('day').toUTC().toJSDate();
  const endOfDay = now.endOf('day').toUTC().toJSDate();

  const startOfDayUtc = startOfDay.toISOString();
  const endOfDayUtc = endOfDay.toISOString();

  const ownerFilter = owner ? `&target_owner=eq.${encodeURIComponent(owner)}` : '';

  console.log(`[countPostedToday] ${platform}/${owner || 'any'} in ${tz}: checking ${startOfDayUtc} to ${endOfDayUtc}`);

  // Count 'posted' AND 'posted_unverified' rows: use posted_at timestamp
  // (accurate). posted_unverified included (Atlas 2026-09-30) — a
  // genuinely-sent-but-unverified post must still count toward today's cap,
  // otherwise this cron would undercount and publish past the real daily
  // limit for that platform.
  const postedFilter = `platform=eq.${encodeURIComponent(platform)}&status=in.(posted,posted_unverified)${ownerFilter}` +
    `&posted_at=gte.${encodeURIComponent(startOfDayUtc)}` +
    `&posted_at=lte.${encodeURIComponent(endOfDayUtc)}` +
    `&select=id,post_id,posted_at`;
  const { data: postedData, ok: postedOk } = await supabaseFetch(`/rest/v1/social_posts?${postedFilter}`);
  const postedCount = postedOk && Array.isArray(postedData) ? postedData.length : 0;

  // Count 'publishing' rows: use publishing_started_at timestamp (set when lock acquired).
  // This catches posts currently in-flight during this cron run so the cap blocks them.
  const publishingFilter = `platform=eq.${encodeURIComponent(platform)}&status=eq.publishing${ownerFilter}` +
    `&publishing_started_at=gte.${encodeURIComponent(startOfDayUtc)}` +
    `&publishing_started_at=lte.${encodeURIComponent(endOfDayUtc)}` +
    `&select=id,post_id,publishing_started_at`;
  const { data: publishingData, ok: publishingOk } = await supabaseFetch(`/rest/v1/social_posts?${publishingFilter}`);
  const publishingCount = publishingOk && Array.isArray(publishingData) ? publishingData.length : 0;

  // Count video_library rows already posted today on this platform/owner
  // (Carter 2026-10-01 — VIDEO-PRIORITY). Previously this function counted
  // ONLY social_posts, while cron-post-videos.js's own getPostCountsToday()
  // counts BOTH social_posts AND video_library into the SAME shared
  // posting_schedule cap. That let text's own gate under-count real usage
  // on any day a video had already posted first — text could then publish
  // past the platform's real max_per_day. Mirrors getPostCountsToday()'s
  // gate_skipped-aware logic exactly: a platform a video row TARGETED but
  // never actually reached Zernio for (gated out, recorded as a
  // 'gate_skipped' zernio_deliveries entry) must not inflate this count —
  // only genuinely-attempted platforms count as real usage.
  const videoFilter = `status=in.(posted,posted_partial)${ownerFilter}` +
    `&posted_date=gte.${encodeURIComponent(startOfDayUtc)}` +
    `&posted_date=lte.${encodeURIComponent(endOfDayUtc)}` +
    `&select=id,platforms,zernio_deliveries`;
  const { data: videoData, ok: videoOk } = await supabaseFetch(`/rest/v1/video_library?${videoFilter}`);
  let videoCount = 0;
  if (videoOk && Array.isArray(videoData)) {
    for (const row of videoData) {
      if (!Array.isArray(row.platforms) || !row.platforms.includes(platform)) continue;
      const skipped = new Set(
        (Array.isArray(row.zernio_deliveries) ? row.zernio_deliveries : [])
          .filter((e) => e && e.status === 'gate_skipped')
          .map((e) => e.platform),
      );
      if (!skipped.has(platform)) videoCount += 1;
    }
  }

  const count = postedCount + publishingCount + videoCount;
  if (count > 0) {
    const postedIds = postedOk && Array.isArray(postedData) ? postedData.map(p => `${p.post_id}(posted)`) : [];
    const publishingIds = publishingOk && Array.isArray(publishingData) ? publishingData.map(p => `${p.post_id}(publishing)`) : [];
    console.log(`[countPostedToday] ${platform}/${owner || 'any'}: found ${count} (${postedCount} posted + ${publishingCount} publishing + ${videoCount} video):`, [...postedIds, ...publishingIds].join(', '));
  }
  return count;
}

// Load today's pending (not-yet-posted) video_library rows for `owner` that
// could reserve a platform slot today — see api/_lib/video-reservation.js
// for the full mechanism/rationale. Fetched fresh per isDueForPublish() call
// (same no-cache style as countPostedToday, immediately above) so a video
// that gets Heath-approved mid-run is reserved for on the very next
// iteration, not just the next cron invocation.
async function loadPendingVideoRowsForReservation(owner) {
  const ownerVal = owner || 'dossie';
  const { data, ok } = await supabaseFetch(
    `/rest/v1/video_library?status=in.(heath_approved,pending_heath_review)` +
    `&target_owner=eq.${encodeURIComponent(ownerVal)}` +
    `&select=id,status,target_owner,platforms,scheduled_for`,
  );
  if (!ok || !Array.isArray(data)) return null; // null = query failed, caller fails closed
  return data;
}

// Decide if `platform` should publish right now: needs schedule row,
// current time >= some slot, daily cap not exhausted.
// Called per-iteration (no caching) so the cap reflects rows freshly posted
// earlier in the same cron run.
async function isDueForPublish(platform, schedules, owner) {
  // Filter by platform AND current day of week
  const tz = 'America/Chicago'; // Default timezone for day calculation
  const today = nowInTz(tz);
  const row = findScheduleRow(schedules, platform, today.dow, owner || 'dossie');
  // BUG FIX (2026-05-29): Previously returned due:true (uncapped publish) when no
  // schedule row existed for this platform+day combo. That let stale approved rows
  // fire on days they shouldn't publish (e.g. a Sunday row with no schedule entry
  // published immediately). Correct behaviour: no schedule = do not publish today.
  if (!row) return { due: false, reason: `no schedule row for ${platform}/${owner || 'dossie'} on day ${today.dow} — skipping` };
  if (!row.is_active) return { due: false, reason: `schedule row for ${platform}/${owner || 'dossie'} is INACTIVE` };

  const slots = (row.time_slots || []).map(hhmmToMin).sort((a, b) => a - b);
  const nowMin = hhmmToMin(today.hhmm);
  const passedSlots = slots.filter((s) => s <= nowMin);
  if (passedSlots.length === 0) {
    return { due: false, reason: `no slot reached yet (now=${today.hhmm}, next=${slots[0] != null ? Math.floor(slots[0]/60).toString().padStart(2,'0')+':'+(slots[0]%60).toString().padStart(2,'0') : 'none'})` };
  }

  // Cap is tracked per (platform, owner) — see countPostedToday. Two accounts
  // on the same platform (e.g. dossie's Facebook Page vs Heath's realtor
  // Facebook Page) share the same time-slot schedule config but each gets
  // its own independent daily-cap counter (Atlas 2026-08-18).
  const cap = row.max_per_day ?? null;
  if (cap != null) {
    const already = await countPostedToday(platform, tz, owner);

    // VIDEO-PRIORITY RESERVATION (Carter, 2026-10-01 — Heath: "Video is the
    // priority. We should always be doing video moving forward."). Text
    // must not consume a slot a pending video needs TODAY. Evaluated here,
    // at text's own run time — not in cron-post-videos.js — because text
    // runs earlier in the day and by the time the video batch scans, the
    // slot text took is already gone. See api/_lib/video-reservation.js for
    // which video rows count as "reserved" and the full incident history.
    //
    // Fails CLOSED (refuses the text post) if the reservation query itself
    // fails: we cannot prove a slot is safe to hand to text without it, and
    // the stated priority is video, not text — same fail-closed posture
    // this file already uses for an unreadable schedule/cap.
    const pendingVideoRows = await loadPendingVideoRowsForReservation(owner);
    if (pendingVideoRows === null) {
      return { due: false, reason: `video-reservation query failed — failing closed for owner=${owner || 'dossie'} (video priority)` };
    }
    const startOfDayIso = DateTime.now().setZone(tz).startOf('day').toUTC().toISO();
    const endOfDayIso = DateTime.now().setZone(tz).endOf('day').toUTC().toISO();
    const reservedForVideo = countReservedForVideo(pendingVideoRows, {
      platform, owner, startOfDayIso, endOfDayIso,
    });

    if (already + reservedForVideo >= cap) {
      return {
        due: false,
        reason: `daily cap reached for owner=${owner || 'dossie'} (${already}/${cap} used, ${reservedForVideo} reserved for pending video today)`,
      };
    }
  }
  return { due: true, reason: `slot ${passedSlots[passedSlots.length - 1]} passed` };
}

// ─── structural-skip visibility (Atlas 2026-09-30, linkedin_personal) ────
//
// isDueForPublish()'s reason string is per-day — "no schedule row for X/Y
// on day N" is EXPECTED and fine for a platform that just doesn't post on
// Sundays. It cannot distinguish that from "this platform/owner has no
// schedule row on ANY day, ever" — the actually-broken case, where a row
// will sit 'approved' forever. The linkedin_personal incident: 7 rows sat
// silently skipped for weeks with zero write-back to the row itself; the
// only visibility was a counter (`skipped_schedule`) inside this cron's
// JSON response body, which nobody reads. This checks the precise
// structural condition and writes it to social_posts.error_message so the
// state is visible in the table, not only in a response nobody polls.
//
// Fetched once per cron run (not per row) and cached — same rationale as
// loadSchedules() itself.
let zernioAccountRowsCache = null;
async function loadZernioAccountRows() {
  if (zernioAccountRowsCache) return zernioAccountRowsCache;
  const { data, ok } = await supabaseFetch('/rest/v1/zernio_accounts?select=platform,owner,is_active');
  zernioAccountRowsCache = ok && Array.isArray(data) ? data : [];
  return zernioAccountRowsCache;
}

// Mirrors findScheduleRow()'s fallback (owner-specific row OR the shared
// owner-IS-NULL row counts as "wired") but ignores day_of_week — this asks
// "does ANY day have an active row for this platform/owner", not "does
// today."
function hasAnyActiveSchedule(schedules, platform, owner) {
  return schedules.some((r) => r.platform === platform && r.is_active && (r.owner === owner || !r.owner));
}

// Returns a ready-to-store error_message string when (platform, owner) has
// no active posting_schedule row on any day and/or no active zernio_accounts
// row — i.e. the destination doesn't exist, not just "hasn't hit its slot
// yet." Returns null when the destination is wired (even if today's slot/cap
// isn't met — that is normal and must stay silent).
async function structuralSkipReason(platform, owner, schedules) {
  const scheduleOk = hasAnyActiveSchedule(schedules, platform, owner);
  const zernioRows = await loadZernioAccountRows();
  // Mirrors lookupZernioAccountId()'s exact-owner match — no shared-row
  // fallback for zernio_accounts.
  const zernioOk = zernioRows.some((r) => r.platform === platform && r.is_active && r.owner === owner);
  if (scheduleOk && zernioOk) return null;
  const missing = [];
  if (!scheduleOk) missing.push('no active posting_schedule row for this platform/owner on any day');
  if (!zernioOk) missing.push('no active zernio_accounts row for this platform/owner');
  return `STRUCTURALLY_UNPUBLISHABLE: ${missing.join(' and ')} — this post can never publish as configured.`;
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
    '/rest/v1/social_posts?select=id,platform,created_at,target_owner&status=eq.approved&scheduled_for=is.null&order=created_at.asc&limit=50'
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

      // findScheduleRow (owner-aware, see loadSchedules() comment above) —
      // `schedules` can now hold more than one row per platform+day (a
      // shared row plus an owner override, e.g. rust's twitter row), so a
      // plain .find() here would pick whichever happens to come first in
      // query order. Orphan-backfill is Dossie's own legacy social_posts
      // pipeline; scope explicitly to the orphan's own target_owner.
      const scheduleRow = findScheduleRow(schedules, platform, dowIndex, orphan.target_owner || 'dossie');
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
  // status IN (posted, posted_unverified) — Atlas 2026-09-30. An unverified
  // send is still a real send; excluding it here would let the exact-same
  // content_hash re-publish within 24h of a send we simply couldn't confirm.
  const filter = `platform=eq.${encodeURIComponent(post.platform)}` +
    `&status=in.(posted,posted_unverified)` +
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

  // Standing-authority gate (api/_lib/ops-policy.js, capability
  // 'publish_content'). Fail-closed: if the flag can't be read, this run
  // does NOT publish — same "never fail open" contract as every other
  // switch in this codebase. Individual gate results (schedule/dedup/
  // media/sanitizer) are unchanged below and logged per-post at publish.
  const { checkCapability } = require('./_lib/ops-policy.js');
  const publishAuthority = await checkCapability('publish_content');
  if (!publishAuthority.allowed) {
    console.warn(`[cron-publish-approved] publish_content capability not autonomous this run (${publishAuthority.decision}: ${publishAuthority.reason}) — skipping.`);
    await recordCronRun('cron-publish-approved', 'skipped', { reason: `ops-policy: ${publishAuthority.reason}` });
    return res.status(200).json({ ok: true, skipped: true, reason: `ops-policy: ${publishAuthority.reason}` });
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
    const decision = await isDueForPublish(post.platform, schedules, post.target_owner || 'dossie');
    if (!decision.due) {
      skippedSchedule++;
      skips.push({ id: post.id, platform: post.platform, reason: decision.reason });

      // Structural case: write it to the row itself so it's visible without
      // reading this cron's response body. Only PATCH when the message
      // actually changed, so a healthy-but-not-yet-due row (which hits this
      // branch every 30 min forever, correctly) doesn't get re-written on
      // every run.
      const structReason = await structuralSkipReason(post.platform, post.target_owner || 'dossie', schedules);
      if (structReason && post.error_message !== structReason) {
        await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ error_message: structReason }),
        });
      }
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
    // video_required is set per-platform in cron-generate-posts.js: true for
    // facebook/instagram/tiktok/youtube (updated 2026-08-26 — the HCTI card
    // path that used to set video_required=false for facebook/instagram is
    // gone; see the "Card renderer — REMOVED" comment block there). Twitter
    // and LinkedIn stay text-only and skip this gate.
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

    // Video-first hard gate for FB Page + IG (Atlas 2026-07-11 R2).
    // Text-only publishes get crushed by the algorithm; HCTI card render was
    // reversed by Heath 2026-07-11. If a card-platform row reaches publish
    // without a media_url, hold it — mark 'pending_video' + release the lock.
    // Video attachment happens upstream (generator + video_library rotation).
    if (IMAGE_CARD_PLATFORMS.has(post.platform) && !post.media_url) {
      const blockReason = `${post.platform} row has no media_url — video-first policy holds until a video is attached (no HCTI card fallback, no text-only publish).`;
      console.warn(`[cron-publish-approved] HOLDING ${post.platform} post ${post.id} — ${blockReason}`);
      await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'pending_video',
          publishing_started_at: null,
          error_message: blockReason.slice(0, 500),
        }),
      });
      skips.push({ id: post.id, platform: post.platform, reason: blockReason });
      continue;
    }

    // Caption sanitizer — final barrier before Zernio.
    // Locked 2026-07-12 after the meetdossie IG account posted the raw
    // "[COMPETITOR REMIX SEED]" internal briefing as a public caption. Any row
    // that still contains internal-briefing markers or stale founding-count
    // text at publish time is flipped to 'failed' and NOT sent to Zernio.
    // See api/_lib/caption-sanitizer.js for the marker list.
    const sanitizerResult = sanitizerCheckPost(post);
    if (!sanitizerResult.ok) {
      const blockReason = `CAPTION_SANITIZER_BLOCK: ${sanitizerResult.reason}`;
      console.error(`[cron-publish-approved] ${blockReason} — post ${post.id} (${post.platform})`);
      await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'failed',
          publishing_started_at: null,
          error_message: blockReason.slice(0, 500),
        }),
      });
      errors.push({
        id: post.id,
        platform: post.platform,
        sanitizer_marker: sanitizerResult.marker,
        error: blockReason,
      });
      await sendFailureAlert(post, blockReason);
      continue;
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
      // FIX #3 (Atlas 2026-06-11), UPGRADED 2026-09-30: if zernio_post_id is
      // null even on a 2xx, this used to still write status='posted' with
      // only an error_message flagging it — indistinguishable from a
      // verified post to anything that just checks status. Now it lands in
      // 'posted_unverified' instead (20260930d migration) so "posted" means
      // "we have a verifiable identifier," full stop. Never auto-republish
      // from this lane — that risks double-posting if Zernio actually fired
      // (feedback_never-retry-an-unverified-send.md).
      const unverified = !!result.unverified || !result.zernio_post_id;
      const patch = await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: unverified ? 'posted_unverified' : 'posted',
          posted_at: new Date().toISOString(),
          publishing_started_at: null,
          zernio_post_id: result.zernio_post_id || null,
          content_tag: result.content_tag || null,
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
        // Standing-authority audit trail (api/_lib/ops-policy.js). Fire-and-
        // forget — never blocks or reverses a publish already committed.
        await logAutonomousAction({
          capability: 'publish_content',
          decision: 'autonomous',
          action: `published ${post.platform} post`,
          firedBy: 'cron-publish-approved',
          gatesPassed: ['schedule', 'dedup', 'media_required', 'caption_sanitizer'],
          refTable: 'social_posts',
          refId: post.id,
          metadata: { platform: post.platform, target_owner: post.target_owner || 'dossie', unverified },
        }).catch(() => {});
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

// Exported for scripts/regression-twitter-length.js — the four 2026-09-22/24/25
// "Tweet text is too long" rejections are locked by a test that calls this
// directly. A pure function that decides what gets sent should be testable
// without standing up the whole handler.
module.exports.splitForTwitter = splitForTwitter;
module.exports.buildPostBody = buildPostBody;
