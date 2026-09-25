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
// Video quality gate (Heath's standing rule 2026-09-15 —
// feedback_every-video-needs-scroll-stopping-hook.md /
// docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md). Vercel cannot run ffmpeg, so this
// checks the quality_status/quality_failed_rules already recorded on the row
// by scripts/queue-finished-videos.py's ingestion-time gate — see
// api/_lib/verify-video-quality.js's file header for why. Blocking: any row
// that isn't quality_status='passed' is held here, never queued for review
// or posted.
const { gateBeforePublish: gateVideoQuality } = require('./_lib/verify-video-quality.js');
// Pipeline B delivery-verification tracking (Carter 2026-09-17 — closes the
// gap where a video_library post's per-platform Zernio result was logged
// and thrown away, leaving nothing for cron-verify-zernio-deliveries.js to
// later confirm. See api/_lib/video-delivery-verify.js file header.
const { buildDeliveryEntry, mergeDeliveryEntries } = require('./_lib/video-delivery-verify.js');
// Routine-approval batching (Heath, 2026-09-17: "batched into the morning
// brief rather than pinging per item"). Same capability and same mechanism
// api/cron-comment-opp-approval.js already uses: when 'batch_routine_approvals'
// is on, the row is advanced to pending_heath_review WITHOUT an individual
// Telegram card, and api/_lib/silence-alarm.js's pickTopDecisions() carries its
// Approve/Reject buttons inside the one daily brief instead (video_library is a
// DECISION_SOURCES entry there, reusing this file's exact callback_data).
// Fails CLOSED to the old per-item send if the flag can't be read — a
// notification Heath never sees is worse than one too many.
const { checkCapability, logAutonomousAction } = require('./_lib/ops-policy.js');

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
  // Dossie's own YouTube channel (@meetdossie, UCLtSlBEakQh-ClTVd_KGhWA).
  // Was `process.env.ZERNIO_YOUTUBE_ACCOUNT_ID || null` — that env var was
  // NEVER set in Vercel, so this resolved to null and every YouTube target
  // failed account resolution silently. That is the whole reason YouTube has
  // never published a single post despite the channel being connected to
  // Zernio since 2026-05-29 with the youtube.upload scope granted.
  // Hardcoded now for the same reason every other platform here is: a Zernio
  // account id is not a secret, and an unset env var must not be able to
  // silently disable a whole platform. The zernio_accounts table lookup in
  // resolveZernioAccountId() still takes precedence over this map.
  youtube:   '6a19ef442b2567671a6aa273',
};

// Default: post video to all connected platforms unless overridden by video.platforms row.
// YouTube is included — videos are the only thing YouTube accepts, which matches our video_library content.
const DEFAULT_PLATFORMS = ['tiktok', 'instagram', 'facebook', 'twitter', 'linkedin', 'youtube'];

// Heath's realtor "Brokerage" Zernio profile only has facebook + instagram
// (+ youtube, no content plan) connected today (docs/PIPELINE.md) — no
// tiktok/twitter/linkedin row exists under owner='heath-realtor'. Falling
// back to the Dossie DEFAULT_PLATFORMS list for a heath-realtor row would
// just generate loud, expected failures on those three. Used only when a
// heath-realtor row ships with an empty platforms array (queue-finished-
// videos.py always sets one explicitly, so this is a legacy-row fallback).
const REALTOR_DEFAULT_PLATFORMS = ['facebook', 'instagram'];

// Default platforms for a video whose row shipped with an empty/missing
// `platforms` array — a legacy-row fallback (queue-finished-videos.py
// always sets one explicitly today, for every owner including rust).
//
// DB-DRIVEN (Carter 2026-09-16 — RUST-OWNER-WIRING). Previously this was an
// if/else on owner literal ('heath-realtor' ? REALTOR_DEFAULT_PLATFORMS :
// DEFAULT_PLATFORMS) — every new owner needed a source change here just to
// get a sane fallback. Now it asks zernio_accounts directly: whatever
// platforms are actively connected for this owner IS the default list, so
// adding a brand is a zernio_accounts INSERT, never a code edit. The two
// hardcoded constants above are kept ONLY as a fail-safe for 'dossie' and
// 'heath-realtor' if the DB read itself fails (matches their pre-existing
// behavior exactly) — a brand-new owner with no DB row and a failed lookup
// gets an empty list (skip that video's default-platform resolution
// entirely) rather than silently spraying it across every platform.
async function defaultPlatformsFor(owner) {
  try {
    const { data, ok } = await supabaseFetch(
      `/rest/v1/zernio_accounts?owner=eq.${encodeURIComponent(owner)}&is_active=eq.true&select=platform`,
    );
    if (ok && Array.isArray(data) && data.length > 0) {
      return [...new Set(data.map((r) => r.platform))];
    }
  } catch (_) { /* fall through to the legacy fail-safe below */ }
  if (owner === 'heath-realtor') return REALTOR_DEFAULT_PLATFORMS;
  if (owner === 'dossie' || !owner) return DEFAULT_PLATFORMS;
  console.warn(`[cron-post-videos] defaultPlatformsFor(${owner}): no active zernio_accounts rows and no legacy fail-safe — returning []`);
  return [];
}

// All posting_schedule rows use America/Chicago; day boundaries and slot
// times are computed in this zone (with per-row tz override if one appears).
const DEFAULT_TZ = 'America/Chicago';

// Load today's posting_schedule rows (ACTIVE AND INACTIVE — inactive rows
// must be visible so the caller can skip those platforms, not fall through
// to "no schedule" ambiguity). Returns Map platform -> { shared: row|null,
// owners: Map<owner, row> }.
//
// OWNER-SCOPED (Carter 2026-09-16 — RUST-OWNER-WIRING /
// 20260916d_rust_owner_wiring.sql). posting_schedule was never owner-scoped
// — every owner posting to a platform shared the exact same slots/cap/
// is_active row. That's fine while every owner agrees a platform should be
// on or off, and breaks the moment they don't: Twitter/X is deliberately
// INACTIVE for Dossie (all 7 day rows) but Rust's connected @Ruststrength
// account needs it active. `owner` is now nullable on this table — NULL
// rows are shared (apply to any owner with no override), a non-null owner
// value overrides the shared row for that owner ONLY, on that exact
// platform+day. gatePlatform() below prefers the owner-specific row.
async function loadTodaySchedule() {
  const { data, ok } = await supabaseFetch(
    '/rest/v1/posting_schedule?select=platform,day_of_week,time_slots,timezone,is_active,max_per_day,owner',
  );
  if (!ok || !Array.isArray(data)) return null; // null = query failed (fail closed upstream)
  const byPlatform = new Map();
  for (const row of data) {
    const dow = DateTime.now().setZone(row.timezone || DEFAULT_TZ).weekday % 7; // luxon: Mon=1..Sun=7 → Sun=0..Sat=6
    if (row.day_of_week !== dow) continue;
    let entry = byPlatform.get(row.platform);
    if (!entry) {
      entry = { shared: null, owners: new Map() };
      byPlatform.set(row.platform, entry);
    }
    if (row.owner) entry.owners.set(row.owner, row);
    else entry.shared = row;
  }
  return byPlatform;
}

// Count today's posts per (owner, platform) pair (video + text), today =
// America/Chicago day. Counts social_posts in posted/publishing state plus
// video_library rows posted today (each such row counts 1 against every
// platform in its platforms array). Returns Map "owner::platform" -> count,
// or null on query failure.
//
// Owner-scoped (Carter 2026-09-15 — mirrors cron-publish-approved.js's
// countPostedToday(platform, tz, owner), Atlas 2026-08-18). Previously this
// counted every owner's posts into ONE shared bucket per platform, so
// Dossie's own facebook/instagram posts exhausted the SAME daily cap
// Heath's realtor Page needs — a realtor listing video got silently
// blocked behind Dossie's own posts and had to be manually cap-raised.
// target_owner defaults to 'dossie' on both tables (see
// 20260817_social_posts_target_owner.sql / 20260910_video_library_target_owner.sql)
// so a legacy/null row still counts correctly.
async function getPostCountsToday() {
  const now = DateTime.now().setZone(DEFAULT_TZ);
  const startIso = encodeURIComponent(now.startOf('day').toUTC().toISO());

  const { data: socialRows, ok: socialOk } = await supabaseFetch(
    `/rest/v1/social_posts?or=(and(status.eq.posted,posted_at.gte.${startIso}),and(status.eq.publishing,publishing_started_at.gte.${startIso}))&select=platform,target_owner`,
  );
  const { data: videoRows, ok: videoOk } = await supabaseFetch(
    `/rest/v1/video_library?status=eq.posted&posted_date=gte.${startIso}&select=platforms,target_owner`,
  );
  if (!socialOk || !videoOk) return null;

  const counts = new Map();
  const key = (owner, platform) => `${owner || 'dossie'}::${platform}`;
  const bump = (owner, p) => counts.set(key(owner, p), (counts.get(key(owner, p)) || 0) + 1);
  if (Array.isArray(socialRows)) socialRows.forEach((r) => r.platform && bump(r.target_owner, r.platform));
  if (Array.isArray(videoRows)) {
    videoRows.forEach((r) => {
      if (Array.isArray(r.platforms)) r.platforms.forEach((p) => bump(r.target_owner, p));
    });
  }
  return counts;
}

// Gate decision for one platform: post or skip, and at what time.
// Returns { post: true, scheduledFor: iso|null } or { post: false, reason }.
// scheduledFor = next slot later today in the schedule tz; null = every slot
// already passed, publish immediately (slot-passed == due, matching
// cron-publish-approved semantics).
// owner scopes both the schedule row (an owner-specific posting_schedule
// override takes precedence over the shared one — see loadTodaySchedule())
// and the daily-cap count (see getPostCountsToday).
function gatePlatform(platform, scheduleByPlatform, counts, owner = 'dossie') {
  const entry = scheduleByPlatform.get(platform);
  const row = entry && (entry.owners.get(owner) || entry.shared);
  if (!row) {
    return { post: false, reason: 'no posting_schedule row for today' };
  }
  if (!row.is_active) {
    return { post: false, reason: 'posting_schedule row is INACTIVE' };
  }
  const cap = row.max_per_day;
  const already = counts.get(`${owner}::${platform}`) || 0;
  if (cap != null && already >= cap) {
    return { post: false, reason: `daily cap reached for owner=${owner} (${already}/${cap})` };
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
function resolvePlatformTargets(label, platforms, scheduleByPlatform, counts, owner = 'dossie') {
  const targets = []; // { platform, scheduledFor }
  const skipped = []; // { platform, reason }
  for (const platform of platforms) {
    const gate = gatePlatform(platform, scheduleByPlatform, counts, owner);
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

// Owner-aware Zernio account lookup (Carter 2026-09-10 — weekly recording
// kit GAP 4). Mirrors cron-publish-approved.js's lookupZernioAccountId():
// video_library rows now carry target_owner ('dossie' | 'heath-realtor',
// see 20260910_video_library_target_owner.sql), and each owner has its own
// row per platform in zernio_accounts (docs/PIPELINE.md). This is the ONLY
// way a heath-realtor video reaches Heath's own Facebook/Instagram — it
// must never fall through to the hardcoded ZERNIO_ACCOUNTS map below, which
// only ever held Dossie's own account IDs.
async function lookupZernioAccountId(platform, owner = 'dossie') {
  try {
    const { data, ok } = await supabaseFetch(
      `/rest/v1/zernio_accounts?platform=eq.${encodeURIComponent(platform)}&owner=eq.${encodeURIComponent(owner)}&is_active=eq.true&select=zernio_account_id&limit=1`,
    );
    if (ok && Array.isArray(data) && data.length > 0) return data[0].zernio_account_id || null;
  } catch (_) { /* swallow */ }
  return null;
}

// Resolves the Zernio account ID for (platform, owner). Looks up
// zernio_accounts first (owner-aware — the only source of truth for
// owner='heath-realtor'); falls back to the legacy hardcoded
// ZERNIO_ACCOUNTS map ONLY for owner='dossie', for backward compatibility
// with rows that predate the zernio_accounts owner column. A
// 'heath-realtor' row with no matching zernio_accounts entry (e.g.
// tiktok/twitter/linkedin — not connected on Heath's Brokerage profile)
// resolves to null and postToZernio() fails that platform explicitly —
// it NEVER silently falls back to a Dossie account.
async function resolveZernioAccountId(platform, owner) {
  const fromTable = await lookupZernioAccountId(platform, owner);
  if (fromTable) return fromTable;
  if (owner === 'dossie') return ZERNIO_ACCOUNTS[platform] || null;
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
//
// `batched` = the 'batch_routine_approvals' capability is on. In that mode the
// status advance still happens (so the row is queued and nothing re-queues it),
// but NO individual Telegram card is sent — the morning brief picks the row up
// from pending_heath_review and renders these exact buttons. This is the whole
// difference between "one video a day" being a useful habit and being a daily
// interruption per item.
async function sendForHeathReview(video, { batched = false } = {}) {
  // Mark as pending_heath_review so next cron run doesn't re-queue it
  await supabaseFetch(
    `/rest/v1/video_library?id=eq.${encodeURIComponent(video.id)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'pending_heath_review' }),
    },
  );

  if (batched) {
    console.log(`[cron-post-videos] ${video.id} queued for the morning brief (batched, no individual ping)`);
    await logAutonomousAction({
      capability: 'batch_routine_approvals',
      decision: 'autonomous',
      action: 'folded a video approval into the morning brief instead of an individual ping',
      firedBy: 'cron-post-videos',
      gatesPassed: ['quality_status_passed', 'supabase_url_present'],
      refTable: 'video_library',
      refId: video.id,
    }).catch(() => {});
    return;
  }

  const owner = video.target_owner || 'dossie';
  const platforms = (Array.isArray(video.platforms) && video.platforms.length > 0)
    ? video.platforms
    : await defaultPlatformsFor(owner);

  const text = [
    `Video ready for review: ${video.topic || video.id}${owner === 'heath-realtor' ? ' [REALTOR]' : ''}`,
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
// owner: 'dossie' (default) | 'heath-realtor' — resolves the Zernio account
// AND Facebook Page independently per owner (GAP 4, Carter 2026-09-10).
// A heath-realtor call NEVER falls back to a dossie account — see
// resolveZernioAccountId().
// NOTE (Carter 2026-09-17 — Quinn QA follow-up on RUST-OWNER-WIRING): the
// clone-voice AI disclosure flags below used to be gated on
// owner==='heath-realtor' — a proxy, not a fact. Rust now posts through this
// exact pipeline (target_owner='rust', see 20260916d_rust_owner_wiring.sql),
// and Heath's cloned voice is approved for realtor AND Rust content
// (heath-voice-clone-usage-scope.md), so an owner-literal check would ship a
// clone-voiced Rust video to YouTube/TikTok with no disclosure the moment
// Rust connects one of those accounts. The flag is now read straight off
// the video row (opts.usesClonedVoice, sourced from
// video_library.uses_cloned_voice — 20260917b_ai_disclosure_content_
// property.sql) — a property of the content, set by whichever pipeline
// actually knows which voice rendered the audio, not derived from who
// posted it.
async function postToZernio(platform, videoUrl, caption, topic, opts = {}, owner = 'dossie') {
  const accountId = await resolveZernioAccountId(platform, owner);
  if (!accountId) {
    return { ok: false, error: `No Zernio account ID for platform: ${platform} (owner: ${owner})` };
  }

  const platformBlock = { platform, accountId };

  // Facebook: pin the exact Page (same fix as cron-publish-approved —
  // without pageId the post lands on whichever Page happens to be selected
  // on Zernio's dashboard toggle, which may be Heath's realtor Page).
  if (platform === 'facebook') {
    const pageId = await lookupZernioPageId('facebook', owner);
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

  // AI-disclosure label (Carter, 2026-09-16; fixed to read off content
  // 2026-09-17) — YouTube and TikTok both require disclosure of realistic
  // AI-generated/synthetic voice or face. heath-voice-clone-usage-scope.md:
  // Heath's ElevenLabs clone (i41TA0Q36AUrp4axERi3) is approved for realtor
  // listing AND Rust content, NEVER for Dossie (Dossie always speaks as
  // Luna). Rust posts through THIS pipeline now (target_owner='rust', see
  // 20260916d_rust_owner_wiring.sql) — so the old owner==='heath-realtor'
  // proxy would silently ship a clone-voiced Rust video with no disclosure.
  // opts.usesClonedVoice is sourced by the caller from
  // video_library.uses_cloned_voice, a fact the content pipeline records at
  // ingestion time (scripts/queue-finished-videos.py) — never inferred from
  // who posted it.
  // Field names verified against Zernio's own API docs (docs.zernio.com,
  // 2026-09-16) and Google's YouTube Data API v3 reference:
  //   YouTube: status.containsSyntheticMedia (realistic Altered/Synthetic content)
  //   TikTok:  tiktokSettings.video_made_with_ai (Business-app video posts only)
  const usesHeathClonedVoice = opts.usesClonedVoice === true;
  if (usesHeathClonedVoice && platform === 'youtube') {
    platformBlock.platformSpecificData = {
      ...(platformBlock.platformSpecificData || {}),
      containsSyntheticMedia: true,
    };
  }
  if (usesHeathClonedVoice && platform === 'tiktok') {
    // NOTE: TikTok's other required tiktokSettings fields (privacy_level,
    // allow_comment, allow_duet, allow_stitch, content_preview_confirmed,
    // express_consent_given) are not sent anywhere in this file today — a
    // pre-existing gap, not introduced here. TikTok isn't connected for
    // owner='heath-realtor' yet either (docs/PIPELINE.md), so this has no
    // live effect until both are fixed. Flagging, not fixing here — out of
    // this change's scope.
    platformBlock.platformSpecificData = {
      ...(platformBlock.platformSpecificData || {}),
      tiktokSettings: {
        ...((platformBlock.platformSpecificData && platformBlock.platformSpecificData.tiktokSettings) || {}),
        video_made_with_ai: true,
      },
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
    // Record a platform URL immediately IF the accept-time response happens
    // to carry one (Carter 2026-09-17 — most Zernio responses don't; the
    // real URL usually only shows up later via GET /posts/:id, which
    // cron-verify-zernio-deliveries.js polls). Never invented — only used
    // if actually present in this exact response.
    const platformUrl =
      data?.url ||
      data?.platform_url ||
      data?.post?.url ||
      data?.data?.url ||
      (data?.post?.platforms && Array.isArray(data.post.platforms) && data.post.platforms[0]?.url) ||
      (Array.isArray(data?.posts) && data.posts[0]?.url) ||
      null;
    if (!zernioPostId) {
      // A 2xx with no post id usually means Zernio silently rejected the
      // post (validation failure on their side). Don't report clean success.
      console.warn(`[cron-post-videos] Zernio ${platform}: 2xx but NO post id in response — treating as unverified. Body: ${text.slice(0, 500)}`);
      return { ok: true, data, zernio_post_id: null, unverified: true, platform_url: platformUrl };
    }
    return { ok: true, data, zernio_post_id: zernioPostId, platform_url: platformUrl };
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

  // --- Manual debug scoping (Atlas 2026-09-25) --------------------------
  // Approved manual-trigger pattern per CLAUDE.md §15: debug params gated
  // behind the existing `Bearer ${CRON_SECRET}` check. NEVER honored on a
  // real Vercel cron invocation — a scheduled run always behaves exactly as
  // it did before this block existed.
  //
  //   ?video_id=<video_library.id>  restrict the publish pass to one row
  //   ?platform=<platform>          restrict that row to ONE platform
  //   ?publish_now=1                publish immediately instead of booking
  //                                 the platform's next posting_schedule
  //                                 slot. The is_active and max_per_day
  //                                 gates still apply — this only collapses
  //                                 "schedule for 14:00" into "publish now",
  //                                 which is the ONLY way to get Zernio to
  //                                 return a synchronous platformPostUrl
  //                                 (scheduled posts return an id and
  //                                 nothing else, so a scheduled post can
  //                                 never be proven live in the same run).
  const dbg = (!isVercelCron && isManualAuth) ? (req.query || {}) : {};
  const onlyVideoId = dbg.video_id ? String(dbg.video_id) : null;
  const onlyPlatform = dbg.platform ? String(dbg.platform).toLowerCase() : null;
  const forcePublishNow = String(dbg.publish_now || '') === '1';
  if (onlyVideoId || onlyPlatform || forcePublishNow) {
    console.log(`[cron-post-videos] MANUAL DEBUG SCOPE video_id=${onlyVideoId || '-'} platform=${onlyPlatform || '-'} publish_now=${forcePublishNow}`);
  }

  const summary = { queued_for_review: [], posted: [], skipped: [] };
  if (onlyVideoId || onlyPlatform || forcePublishNow) {
    summary.manual_scope = { video_id: onlyVideoId, platform: onlyPlatform, publish_now: forcePublishNow };
  }

  // --- STEP 1: Queue any 'approved' videos for Heath's review (do NOT post them) ---
  // Skipped entirely under a manual ?video_id= scope: a targeted one-row
  // publish must not also fire a batch of review notifications at Heath.
  let approvedVideos = [];
  if (!onlyVideoId) {
    const { data: approvedRows, ok: approvedOk } = await supabaseFetch(
      '/rest/v1/video_library?status=eq.approved&order=created_at.asc',
    );

    if (!approvedOk) {
      return res.status(502).json({ ok: false, error: 'Failed to query approved videos' });
    }

    approvedVideos = Array.isArray(approvedRows) ? approvedRows : [];
  }

  // Read the batching capability ONCE for the whole pass. Fail closed to the
  // old per-item send: if the flag can't be read we do not risk a video
  // sitting in a brief that never renders it.
  let batched = false;
  try {
    const cap = await checkCapability('batch_routine_approvals');
    batched = cap && cap.allowed === true;
  } catch (err) {
    console.warn('[cron-post-videos] batch_routine_approvals unreadable, sending individually:', err && err.message);
  }
  summary.batched_into_brief = batched;

  for (const video of approvedVideos) {
    if (!video.supabase_url) {
      const warn = `Video ${video.id} is approved but supabase_url is null — run scripts/upload-video.py first`;
      console.warn(`[cron-post-videos] ${warn}`);
      await sendTelegramMessage(`Video pipeline: ${warn}`);
      summary.skipped.push({ id: video.id, reason: 'no supabase_url' });
      continue;
    }
    const qualityOk = await gateVideoQuality(video);
    if (!qualityOk) {
      summary.skipped.push({ id: video.id, reason: 'quality gate blocked (see quality_hold alert)' });
      continue;
    }
    await sendForHeathReview(video, { batched });
    summary.queued_for_review.push(video.id);
  }

  // --- STEP 2: Post any 'heath_approved' videos to Zernio ---
  // Fetch a BATCH, not just the single oldest row (Carter 2026-09-15 fix).
  // Previously this pulled limit=1 — when the oldest row's platforms were
  // all at their daily cap, it sat back at 'heath_approved' and every newer
  // row behind it was silently blocked, forever, since the same oldest row
  // gets re-selected on every run. Now we scan up to CANDIDATE_BATCH_SIZE
  // oldest rows and post the first one that has at least one platform with
  // cap room today. Rows skipped this pass are untouched and re-considered
  // next run (or picked up sooner once cap room frees up).
  const CANDIDATE_BATCH_SIZE = 20;
  const { data: heathApprovedRows, ok: heathApprovedOk } = await supabaseFetch(
    `/rest/v1/video_library?status=eq.heath_approved${onlyVideoId ? `&id=eq.${encodeURIComponent(onlyVideoId)}` : ''}&order=created_at.asc&limit=${CANDIDATE_BATCH_SIZE}`,
  );

  if (!heathApprovedOk) {
    return res.status(502).json({ ok: false, error: 'Failed to query heath_approved videos' });
  }

  const candidates = Array.isArray(heathApprovedRows) ? heathApprovedRows : [];

  let libraryOk = true;
  let videoResults = [];
  let videoId = null;
  let platformsAttempted = [];

  if (candidates.length === 0) {
    console.log('[cron-post-videos] No heath_approved videos — nothing to post');
  } else {
    // Schedule + cap gate (2026-09-07). Fail CLOSED: if we can't read the
    // schedule or today's counts, we cannot prove ANY post is within cap,
    // so nothing posts this run (all candidate rows stay heath_approved).
    // Loaded once for the whole batch scan — every candidate is evaluated
    // against the same schedule/counts snapshot.
    const scheduleByPlatform = await loadTodaySchedule();
    const counts = scheduleByPlatform ? await getPostCountsToday() : null;

    if (!scheduleByPlatform || !counts) {
      console.error('[cron-post-videos] posting_schedule / post-count query failed — failing closed, not posting');
      libraryOk = false;
      summary.skipped.push({ reason: 'schedule/cap query failed — fail closed', candidates: candidates.length });
    } else {
      // Scan candidates oldest-first for the first one with eligible platform
      // room. Rows with a hard blocker (no supabase_url, invalid caption)
      // are resolved immediately (warned/failed) and skipped, same as
      // before, but scanning continues to the next candidate instead of
      // stopping the whole run.
      let video = null;
      let targets = [];
      let platformSkips = [];

      for (const candidate of candidates) {
        if (!candidate.supabase_url) {
          const warn = `Video ${candidate.id} is heath_approved but supabase_url is null`;
          console.warn(`[cron-post-videos] ${warn}`);
          await sendTelegramMessage(`Video pipeline: ${warn}`);
          summary.skipped.push({ id: candidate.id, reason: 'no supabase_url' });
          continue;
        }

        const captionCheck = (candidate.caption || '').trim().toLowerCase();
        if (!captionCheck || captionCheck.startsWith('pulled') || captionCheck.includes('do not repost') || captionCheck.includes('internal')) {
          const warn = `Video ${candidate.id} has an invalid caption ("${(candidate.caption || '').slice(0, 60)}") — skipping to prevent internal notes from posting publicly`;
          console.warn(`[cron-post-videos] ${warn}`);
          await sendTelegramMessage(`Video pipeline safety check: ${warn}`);
          await supabaseFetch(
            `/rest/v1/video_library?id=eq.${encodeURIComponent(candidate.id)}`,
            { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'failed' }) },
          );
          summary.skipped.push({ id: candidate.id, reason: 'invalid caption' });
          continue;
        }

        // Rust content rule (Heath, 2026-09-16 — RUST-OWNER-WIRING, see
        // memory rust-app-store-submission-state.md): no store link / "download
        // now" language while iOS/Android aren't both live yet. The CTA is
        // always the waitlist at rustfitness.app. Caught here so a caption
        // slipping past generation still can't ship a broken/premature CTA.
        if ((candidate.target_owner || 'dossie') === 'rust') {
          const rustCta = captionCheck;
          if (/\b(download( it)? now|get it on|app store|google play|available now on)\b/.test(rustCta)) {
            const warn = `Video ${candidate.id} (owner=rust) caption references a store/download CTA before iOS/Android are live: "${(candidate.caption || '').slice(0, 80)}"`;
            console.warn(`[cron-post-videos] ${warn}`);
            await sendTelegramMessage(`Video pipeline safety check: ${warn}`);
            await supabaseFetch(
              `/rest/v1/video_library?id=eq.${encodeURIComponent(candidate.id)}`,
              { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'failed' }) },
            );
            summary.skipped.push({ id: candidate.id, reason: 'rust store-link CTA before launch' });
            continue;
          }
        }

        const qualityOk = await gateVideoQuality(candidate);
        if (!qualityOk) {
          summary.skipped.push({ id: candidate.id, reason: 'quality gate blocked at publish (see quality_hold alert)' });
          continue;
        }

        const owner = candidate.target_owner || 'dossie';
        let requested = (Array.isArray(candidate.platforms) && candidate.platforms.length > 0)
          ? candidate.platforms
          : await defaultPlatformsFor(owner);
        // Manual ?platform= narrows to one of the row's OWN platforms. It can
        // never add a platform the row wasn't already configured for.
        if (onlyPlatform) {
          requested = requested.filter((p) => String(p).toLowerCase() === onlyPlatform);
        }
        const resolved = resolvePlatformTargets(`video ${candidate.id}`, requested, scheduleByPlatform, counts, owner);
        // ?publish_now=1 collapses a booked slot into an immediate publish.
        // The is_active / max_per_day gates above already ran and still bind.
        if (forcePublishNow) {
          for (const t of resolved.targets) t.scheduledFor = null;
        }

        if (resolved.targets.length === 0) {
          console.log(`[cron-post-videos] Video ${candidate.id}: no platform eligible today — leaving heath_approved, checking next candidate`);
          summary.skipped.push({ id: candidate.id, reason: 'no eligible platform today', platform_skips: resolved.skipped });
          continue;
        }

        video = candidate;
        targets = resolved.targets;
        platformSkips = resolved.skipped;
        break;
      }

      if (!video) {
        console.log(`[cron-post-videos] No candidate among ${candidates.length} heath_approved rows has an eligible platform today`);
      } else {
        videoId = video.id;
        const owner = video.target_owner || 'dossie';
        console.log(`[cron-post-videos] Posting heath_approved video: ${video.id} (owner: ${owner})`);
        summary.platform_skips = platformSkips;

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

          const nowIso = new Date().toISOString();
          const deliveryEntries = [];
          for (const t of targets) {
            const result = await postToZernio(
              t.platform, video.supabase_url, caption, video.topic,
              { scheduledFor: t.scheduledFor, usesClonedVoice: video.uses_cloned_voice === true }, owner,
            );
            videoResults.push({ platform: t.platform, scheduledFor: t.scheduledFor, ...result });
            deliveryEntries.push(buildDeliveryEntry({
              platform: t.platform,
              scheduledFor: t.scheduledFor,
              postResult: result,
              nowIso,
            }));
            if (!result.ok) {
              libraryOk = false;
              console.error(`[cron-post-videos] Failed on ${t.platform}:`, result.error);
            } else {
              console.log(`[cron-post-videos] ${t.platform} accepted (${t.scheduledFor ? `scheduled ${t.scheduledFor}` : 'publish now'})${result.unverified ? ' — UNVERIFIED (no post id)' : ''}`);
            }
          }
          // Persist per-platform delivery state so cron-verify-zernio-deliveries.js
          // can confirm actual delivery later — previously this was logged
          // and discarded, the exact gap this fix closes.
          const zernioDeliveries = mergeDeliveryEntries(video.zernio_deliveries, deliveryEntries);

          if (libraryOk) {
            await supabaseFetch(
              `/rest/v1/video_library?id=eq.${encodeURIComponent(video.id)}`,
              {
                method: 'PATCH',
                headers: { Prefer: 'return=minimal' },
                body: JSON.stringify({ status: 'posted', posted_date: new Date().toISOString(), zernio_deliveries: zernioDeliveries }),
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
                body: JSON.stringify({ status: 'failed', posted_date: null, zernio_deliveries: zernioDeliveries }),
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
  // Skipped under a manual scope — a targeted one-row run must not also
  // publish an unrelated skit as a side effect.
  const skitPostResult = (onlyVideoId || onlyPlatform)
    ? { posted: [], skipped: [], scoped_out: true }
    : await postApprovedSkits();
  summary.skit_posted = skitPostResult.posted;

  // --- STEP 4: Alert if approved videos have sat unposted for 48h+ ---
  // Silent-failure guard: without this, the batch-scan fix in STEP 2 can
  // still leave a video capped-out on every one of its platforms for days
  // and nobody would know until Heath noticed the gap himself. video_library
  // has no approved_at column, so created_at is the best available proxy
  // for "how long has this been sitting."
  summary.stale_approved = await alertStaleApprovedVideos();

  return res.status(200).json({
    ok: libraryOk,
    video_id: videoId,
    platforms_attempted: platformsAttempted,
    results: videoResults,
    summary,
  });
});

// video_library rows stuck at 'heath_approved' (or still 'approved',
// awaiting Heath's review tap) past 48h mean the video pipeline is backed
// up — either every platform is capped out day after day, or a review
// message never got tapped. Reuses the same sendTelegramMessage helper as
// the rest of this cron; runs every invocation (daily), so this is at most
// one extra message/day while the condition persists — acceptable given
// there's no separate alert-dedup table for this cron today.
async function alertStaleApprovedVideos() {
  const cutoffIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data, ok } = await supabaseFetch(
    `/rest/v1/video_library?status=in.(approved,heath_approved)&created_at=lt.${encodeURIComponent(cutoffIso)}&select=id,status,topic,created_at&order=created_at.asc`,
  );
  if (!ok || !Array.isArray(data) || data.length === 0) return { count: 0 };

  const lines = [
    `Video pipeline alert: ${data.length} video(s) approved but unposted for 48h+`,
    ...data.slice(0, 10).map((v) => `- ${v.id} (${v.status}, since ${v.created_at})`),
    data.length > 10 ? `...and ${data.length - 10} more` : null,
  ].filter(Boolean);
  console.warn(`[cron-post-videos] STALE ALERT: ${data.length} approved video(s) unposted 48h+`);
  await sendTelegramMessage(lines.join('\n'));
  return { count: data.length, ids: data.map((v) => v.id) };
}

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
  // Skits are always Dossie's own content (SKIT_PLATFORMS never carries a
  // target_owner) — explicit 'dossie' here, not relying on the default.
  const { targets, skipped: platformSkips } = resolvePlatformTargets(
    `skit ${skitId}`, SKIT_PLATFORMS, scheduleByPlatform, counts, 'dossie',
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
