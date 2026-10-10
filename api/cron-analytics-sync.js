// Vercel Serverless Function: /api/cron-analytics-sync
// Weekly cron (Sunday 2AM UTC) that pulls post engagement stats from the
// Zernio analytics API and writes them into:
//   1. post_analytics — one row per (social_post, sync_date) for historical trend data
//   2. social_posts — updates inline metrics columns (likes, comments, shares, etc.)
//      and sets top_performer=true on above-average posts
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — "0 2 * * 0" (Sunday 2AM UTC)
//
// Top-performer threshold: engagement_score in the top 20% of all posted rows
// with at least one Zernio analytics fetch. The threshold is recomputed each
// run so it adjusts naturally as the content library grows.
//
// Zernio known issue: zernio_post_id is NULL on many rows (response-shape
// mismatch in cron-publish-approved — known tech debt). For rows without a
// zernio_post_id we fall back to matching by accountId + posted_at window
// (+-5 min) in the Zernio paginated response, then back-fill the ID if found.
//
// OWNER ATTRIBUTION + VIDEO POSTS (Atlas, 2026-09-30 — video-routing-
// personal-accounts task). Two gaps closed here:
//
//   1. ZERNIO_ACCOUNTS used to be 4 hardcoded Dossie-brand account IDs.
//      Heath's personal accounts (zernio_accounts owner='heath-realtor':
//      facebook/instagram/youtube) and Rust's (owner='rust') were never
//      scanned at all — their engagement was invisible here regardless of
//      platform. Now loaded live from zernio_accounts (is_active=true),
//      with owner + account_handle carried through onto every
//      post_analytics row so a personal-account post's engagement can
//      finally be told apart from a brand post's on the SAME platform
//      (e.g. two 'facebook' rows, one @MeetDossie, one
//      @HeathShepardRealtor).
//   2. post_analytics.social_post_id is a hard FK to social_posts ONLY.
//      video_library posts (cron-post-videos.js, Pipeline B — the pipeline
//      the personal-account routing change actually runs through) have
//      NEVER been able to land a row here, on ANY account. Confirmed live
//      2026-09-30: zero post_analytics rows reference a video post. This
//      file's per-account Zernio pull already returns every post under an
//      account regardless of which pipeline made it — matchVideoRow()
//      below matches it against video_library.zernio_deliveries[].
//      zernio_post_id the same way byZernioId already matches social_posts.
//
// REQUIRES supabase/migrations/20260930_post_analytics_owner_attribution.sql
// (api/admin-migrate-post-analytics-owner.js) to have been run FIRST —
// post_analytics.owner/account_handle/video_library_id do not exist until
// then, and every upsert below that sets them will 400 on a DB that hasn't
// been migrated yet. NOT applied as part of this branch/PR; see that
// migration file's header.

// Scheduled-Telegram kill switch (Atlas 2026-08-16). Gates unattended pushes
// to Heath behind TELEGRAM_CRON_NOTIFICATIONS. Two-way chat is unaffected.
require('./_lib/telegram-gate').install('cron-analytics-sync');

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const { retryFetch } = require('./_lib/retry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const ZERNIO_BASE = 'https://zernio.com/api/v1';

// Fail-safe fallback ONLY (Atlas, 2026-09-30) — used if the live
// zernio_accounts read below fails. Was the hard-coded account list this
// whole file used to run on; kept as-is (4 Dossie-brand accounts, "TikTok
// omitted — inactive") for exact backward compatibility on a DB-read
// failure. That "inactive" note is now known STALE — probed live 2026-09-30
// via GET /v1/analytics?accountId=<dossie tiktok>: hasAnalyticsAccess:true,
// 7 real posts, 24-100 views each (measurably BETTER than the 0-2 views
// FB/IG/LinkedIn brand posts got over the same window) — TikTok was simply
// never being scanned, not actually broken. Fixed for the live path below;
// left alone here since this is a frozen fail-safe snapshot, not the
// current behavior.
const ZERNIO_ACCOUNTS_FALLBACK = [
  { platform: 'facebook',  accountId: '69f253c3985e734bf3d8f9bc', owner: 'dossie', accountHandle: '@meetdossie' },
  { platform: 'instagram', accountId: '69f25431985e734bf3d8fcbe', owner: 'dossie', accountHandle: '@meetdossie' },
  { platform: 'twitter',   accountId: '69f255c6985e734bf3d90ba1', owner: 'dossie', accountHandle: '@meetdossie' },
  { platform: 'linkedin',  accountId: '69fccd7392b3d8e85f8f12be', owner: 'dossie', accountHandle: 'meetdossie' },
];

// Live-loaded account list (Atlas, 2026-09-30 — video-routing-personal-
// accounts task). Replaces the hardcoded 4-Dossie-account list above with
// every actively-connected zernio_accounts row, across every owner
// ('dossie' | 'heath-realtor' | 'rust'). This is the ONLY reason Heath's
// personal accounts (facebook/instagram/youtube, owner='heath-realtor')
// and Rust's (instagram/twitter, owner='rust') were never scanned for
// engagement before — they simply weren't in this list, regardless of
// platform. owner + accountHandle are carried onto every post_analytics row
// this sync writes (REQUIRES the 20260930_post_analytics_owner_attribution
// migration — see this file's header).
async function loadZernioAccounts() {
  try {
    const { data, ok } = await supabaseFetch(
      '/rest/v1/zernio_accounts?is_active=eq.true&select=platform,zernio_account_id,owner,account_handle',
    );
    if (ok && Array.isArray(data) && data.length > 0) {
      return data.map((r) => ({
        platform: r.platform,
        accountId: r.zernio_account_id,
        owner: r.owner || 'dossie',
        accountHandle: r.account_handle || null,
      }));
    }
  } catch (err) {
    console.error('[analytics-sync] zernio_accounts load failed, using fallback list:', err && err.message);
  }
  console.warn('[analytics-sync] zernio_accounts table read returned nothing usable — falling back to the frozen 4-account list');
  return ZERNIO_ACCOUNTS_FALLBACK;
}

// Max Vercel Hobby function duration is 60s for crons. We set maxDuration:60
// in vercel.json. The Zernio calls are paginated and bounded so this is safe.

// ─── Supabase helper ──────────────────────────────────────────────────────

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

// ─── Zernio analytics fetcher ─────────────────────────────────────────────

// Fetch all analytics rows for a given accountId from the last 90 days.
// Zernio paginates at 100 rows per page — we loop until no more pages.
async function fetchZernioAnalytics(accountId) {
  const fromDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const toDate = new Date().toISOString().slice(0, 10);

  const rows = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const params = new URLSearchParams({
      accountId,
      fromDate,
      toDate,
      limit: String(limit),
      page: String(page),
      order: 'desc',
    });

    let res;
    try {
      res = await retryFetch(
        `${ZERNIO_BASE}/analytics?${params}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${ZERNIO_API_KEY}`,
            'Content-Type': 'application/json',
          },
        },
        { name: 'Zernio-analytics', maxAttempts: 3, baseDelay: 1500 },
      );
    } catch (err) {
      console.error(`[analytics-sync] Zernio fetch error accountId=${accountId} page=${page}:`, err && err.message);
      break;
    }

    const text = await res.text();
    console.log(`[analytics-sync] accountId=${accountId} page=${page} status=${res.status} body=${text.slice(0, 200)}`);

    if (!res.ok) {
      console.error(`[analytics-sync] Zernio ${res.status} for accountId=${accountId}: ${text.slice(0, 300)}`);
      break;
    }

    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!body) break;

    // Zernio response shape: { posts: [...] } or array directly.
    const pageItems = Array.isArray(body) ? body
      : Array.isArray(body.posts) ? body.posts
      : Array.isArray(body.data) ? body.data
      : [];

    rows.push(...pageItems);

    // Stop when we get fewer rows than the page limit (last page).
    if (pageItems.length < limit) break;
    page++;

    // Safety cap: never fetch more than 10 pages (1000 posts) per account.
    if (page > 10) {
      console.warn(`[analytics-sync] hit 10-page cap for accountId=${accountId}`);
      break;
    }
  }

  return rows;
}

// ─── Metric extractor ─────────────────────────────────────────────────────

// Normalise the Zernio analytics object (could be nested under .analytics or flat).
function extractMetrics(zPost) {
  const a = zPost.analytics || zPost; // flat fallback
  return {
    likes:           safeInt(a.likes),
    comments:        safeInt(a.comments),
    shares:          safeInt(a.shares),
    saves:           safeInt(a.saves),
    clicks:          safeInt(a.clicks),
    views:           safeInt(a.views ?? a.videoViews),
    impressions:     safeInt(a.impressions),
    reach:           safeInt(a.reach),
    engagement_rate: safeFloat(a.engagementRate),
  };
}

function safeInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}
function safeFloat(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0;
}

// ─── Top-performer threshold ───────────────────────────────────────────────

// Compute the 80th-percentile engagement_score across all rows in
// post_analytics that have at least one non-zero metric. Posts scoring above
// this threshold get top_performer=true.
async function computeTopPerformerThreshold() {
  const { data, ok } = await supabaseFetch(
    `/rest/v1/post_analytics?select=engagement_score&engagement_score=gt.0&order=engagement_score.desc`,
  );
  if (!ok || !Array.isArray(data) || data.length === 0) return 0;

  const scores = data.map((r) => Number(r.engagement_score || 0)).sort((a, b) => a - b);
  const p80idx = Math.floor(scores.length * 0.8);
  return scores[p80idx] ?? 0;
}

// ─── Telegram notification ─────────────────────────────────────────────────

async function sendTelegramSummary(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('[analytics-sync] telegram notify failed:', err && err.message);
  }

  // Also deliver to Sage's chat (DossieSageBot) so she has analytics context.
  const TELEGRAM_SAGE_BOT_TOKEN = process.env.TELEGRAM_SAGE_BOT_TOKEN;
  if (TELEGRAM_SAGE_BOT_TOKEN) {
    try {
      const stripped = String(text).replace(/<[^>]+>/g, '');
      const sageRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_SAGE_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: `[WEEKLY ANALYTICS]\n${stripped}`,
        }),
      });
      if (sageRes.ok) {
        await supabaseFetch('/rest/v1/sage_conversations', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            chat_id: String(TELEGRAM_CHAT_ID),
            role: 'user',
            text: `[WEEKLY ANALYTICS]\n${stripped}`,
          }),
        });
      }
    } catch (err) {
      console.warn('[analytics-sync] sage delivery failed:', err && err.message);
    }
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────

module.exports = withTelemetry('cron-analytics-sync', async function handler(req, res) {
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
    console.warn('[analytics-sync] ZERNIO_API_KEY not set — skipping');
    return res.status(200).json({ ok: true, skipped: true, reason: 'zernio not configured' });
  }

  const syncDate = new Date().toISOString().slice(0, 10);
  let totalFetched = 0;
  let totalMatched = 0;
  let totalUpserted = 0;
  let totalBackfilled = 0;
  const errors = [];

  // Load all posted social_posts rows upfront so we can match by zernio_post_id
  // or by (platform, posted_at) window for rows where zernio_post_id is null.
  const { data: allPosted, ok: loadOk } = await supabaseFetch(
    `/rest/v1/social_posts?status=eq.posted&select=id,post_id,platform,zernio_post_id,posted_at,zernio_account_id,persona,topic,hook,hook_type,cta_type,hook_variant&order=posted_at.desc&limit=500`,
  );
  if (!loadOk || !Array.isArray(allPosted)) {
    return res.status(502).json({ ok: false, error: 'failed to load posted rows from Supabase' });
  }
  console.log(`[analytics-sync] loaded ${allPosted.length} posted rows from Supabase`);

  // Build lookup maps
  const byZernioId = new Map(); // zernio_post_id -> social_posts row
  const byAccountAndTime = []; // [{accountId, postedAt, row}] for fuzzy match
  for (const row of allPosted) {
    if (row.zernio_post_id) {
      byZernioId.set(String(row.zernio_post_id), row);
    }
    if (row.zernio_account_id && row.posted_at) {
      byAccountAndTime.push({
        accountId: row.zernio_account_id,
        postedAt: new Date(row.posted_at).getTime(),
        row,
      });
    }
  }

  // Video-library (Pipeline B) match map (Atlas, 2026-09-30). video_library
  // has no zernio_account_id/posted_at columns to fuzzy-match on like
  // social_posts does — only the exact zernio_post_id recorded per-platform
  // in zernio_deliveries[] (api/_lib/video-delivery-verify.js) at post
  // time. Exact-match only; a video row with no zernio_post_id (Zernio gave
  // us nothing to poll — 'unconfirmable' in that module's terms) simply
  // can't be attributed here, same as it can't be verified as delivered
  // elsewhere in the pipeline.
  const byZernioIdVideo = new Map(); // zernio_post_id -> { id, target_owner, platform }
  const { data: videoRows, ok: videoLoadOk } = await supabaseFetch(
    '/rest/v1/video_library?status=eq.posted&zernio_deliveries=not.is.null&select=id,target_owner,zernio_deliveries&order=posted_date.desc&limit=500',
  );
  if (videoLoadOk && Array.isArray(videoRows)) {
    for (const row of videoRows) {
      for (const delivery of (Array.isArray(row.zernio_deliveries) ? row.zernio_deliveries : [])) {
        if (delivery && delivery.zernio_post_id) {
          byZernioIdVideo.set(String(delivery.zernio_post_id), {
            id: row.id,
            target_owner: row.target_owner || 'dossie',
            platform: delivery.platform,
          });
        }
      }
    }
    console.log(`[analytics-sync] loaded ${videoRows.length} posted video_library rows, ${byZernioIdVideo.size} zernio_post_id(s) indexed`);
  } else {
    console.warn('[analytics-sync] video_library load failed — video posts will not be attributed this run (social_posts matching is unaffected)');
  }

  // Process each account
  const ZERNIO_ACCOUNTS = await loadZernioAccounts();
  console.log(`[analytics-sync] scanning ${ZERNIO_ACCOUNTS.length} zernio_accounts row(s): ${ZERNIO_ACCOUNTS.map((a) => `${a.platform}/${a.owner}`).join(', ')}`);
  let totalVideoMatched = 0;
  for (const account of ZERNIO_ACCOUNTS) {
    console.log(`[analytics-sync] fetching ${account.platform} (${account.accountId})`);
    let zPosts;
    try {
      zPosts = await fetchZernioAnalytics(account.accountId);
    } catch (err) {
      errors.push({ platform: account.platform, error: err && err.message });
      continue;
    }
    totalFetched += zPosts.length;
    console.log(`[analytics-sync] ${account.platform}: got ${zPosts.length} analytics rows from Zernio`);

    for (const zPost of zPosts) {
      // zPost.postId is the Zernio post ID (MongoDB ObjectId string)
      const zId = String(zPost.postId || zPost.id || zPost.latePostId || '');
      const zPublishedAt = zPost.publishedAt || zPost.createdAt || zPost.scheduledAt;
      const metrics = extractMetrics(zPost);

      // Step 1: try exact match by zernio_post_id
      let matchedRow = zId ? byZernioId.get(zId) : null;

      // Step 2: if no exact match, try fuzzy match by accountId + published_at within 5 min
      if (!matchedRow && zPublishedAt && account.accountId) {
        const zTime = new Date(zPublishedAt).getTime();
        if (!isNaN(zTime)) {
          const candidate = byAccountAndTime.find(
            (e) => e.accountId === account.accountId && Math.abs(e.postedAt - zTime) <= 5 * 60 * 1000,
          );
          if (candidate) {
            matchedRow = candidate.row;
            // Back-fill the zernio_post_id on the social_posts row so future
            // runs use the fast exact-match path.
            if (zId && !matchedRow.zernio_post_id) {
              const enc = encodeURIComponent(matchedRow.id);
              const patchRes = await supabaseFetch(`/rest/v1/social_posts?id=eq.${enc}`, {
                method: 'PATCH',
                headers: { Prefer: 'return=minimal' },
                body: JSON.stringify({ zernio_post_id: zId }),
              });
              if (patchRes.ok) {
                matchedRow.zernio_post_id = zId; // update local copy
                byZernioId.set(zId, matchedRow);  // add to fast lookup
                totalBackfilled++;
                console.log(`[analytics-sync] back-filled zernio_post_id=${zId} on ${matchedRow.post_id}`);
              }
            }
          }
        }
      }

      // Video-library (Pipeline B) match — exact zernio_post_id only, tried
      // whenever the social_posts match above missed. A given zId can only
      // ever be EITHER a social_posts post OR a video_library post (Zernio
      // post IDs are unique per real post), so checking both maps is safe —
      // never double-attributed.
      const matchedVideoRow = !matchedRow && zId ? byZernioIdVideo.get(zId) : null;

      if (!matchedRow && !matchedVideoRow) continue; // Zernio post we didn't publish (scheduled from Zernio UI, etc.)

      // engagement_score is a generated column in Postgres — do NOT include it in the
      // insert payload. Postgres computes it automatically from likes/comments/shares/saves/clicks.

      if (matchedVideoRow) {
        totalMatched++;
        totalVideoMatched++;
        // on_conflict MUST include platform (fixed 2026-10-09, Atlas): a
        // single video_library row has one delivery per platform
        // (facebook/instagram/tiktok/youtube...), all synced on the SAME
        // sync_date in the SAME run. on_conflict=video_library_id,sync_date
        // alone collided across platforms -- confirmed live, every
        // multi-platform video ended up with exactly ONE surviving
        // post_analytics row (whichever platform's account this loop
        // processed last for that owner), silently overwriting every
        // earlier platform's row for the same video+day. Needs the matching
        // unique index -- see idx_post_analytics_video_per_day in
        // supabase/migrations/20261009_post_analytics_video_unique_fix.sql.
        const videoAnalyticsRow = {
          video_library_id: matchedVideoRow.id,
          zernio_post_id: zId,
          platform: account.platform,
          owner: account.owner,
          account_handle: account.accountHandle,
          synced_at: new Date().toISOString(),
          sync_date: syncDate,
          ...metrics,
        };
        const videoUpsertRes = await supabaseFetch(
          '/rest/v1/post_analytics?on_conflict=video_library_id,platform,sync_date',
          {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(videoAnalyticsRow),
          },
        );
        if (videoUpsertRes.ok) {
          totalUpserted++;
        } else {
          console.error(`[analytics-sync] video upsert failed for ${matchedVideoRow.id}:`, videoUpsertRes.status, JSON.stringify(videoUpsertRes.data).slice(0, 200));
          errors.push({ video_library_id: matchedVideoRow.id, error: `upsert HTTP ${videoUpsertRes.status}` });
        }
        continue; // never falls through to the social_posts branch below
      }

      totalMatched++;

      // Upsert into post_analytics (one row per social_post per sync_date)
      const analyticsRow = {
        social_post_id: matchedRow.id,
        zernio_post_id: zId || matchedRow.zernio_post_id || null,
        platform: account.platform,
        owner: account.owner,
        account_handle: account.accountHandle,
        persona: matchedRow.persona || null,
        topic: matchedRow.topic || null,
        hook: matchedRow.hook || null,
        // Copy the hook/CTA classification + explicit hook-variant test label
        // from social_posts so cron-weekly-post-review.js / sage_weekly_review.js
        // can actually bucket by them. These columns existed since 2026-07-08
        // (hook_type/cta_type) and hook_variant added 2026-08-18, but were
        // never copied here — every post_analytics row had them stuck at NULL.
        hook_type: matchedRow.hook_type || null,
        cta_type: matchedRow.cta_type || null,
        hook_variant: matchedRow.hook_variant || null,
        synced_at: new Date().toISOString(),
        sync_date: syncDate,
        ...metrics,
      };

      const upsertRes = await supabaseFetch(
        `/rest/v1/post_analytics?on_conflict=social_post_id,sync_date`,
        {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(analyticsRow),
        },
      );
      if (upsertRes.ok) {
        totalUpserted++;
        // Also update the inline columns on social_posts for quick reads
        await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(matchedRow.id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            likes: metrics.likes,
            comments: metrics.comments,
            shares: metrics.shares,
            clicks: metrics.clicks,
            views: metrics.views,
            last_analytics_fetch: new Date().toISOString(),
          }),
        });
      } else {
        console.error(`[analytics-sync] upsert failed for ${matchedRow.post_id}:`, upsertRes.status, JSON.stringify(upsertRes.data).slice(0, 200));
        errors.push({ post_id: matchedRow.post_id, error: `upsert HTTP ${upsertRes.status}` });
      }
    }
  }
  console.log(`[analytics-sync] ${totalVideoMatched} Zernio analytics row(s) matched to a video_library post this run`);

  // ─── Recompute top_performer flags ────────────────────────────────────────
  // 1. Compute 80th-percentile threshold across all synced rows
  const threshold = await computeTopPerformerThreshold();
  console.log(`[analytics-sync] top_performer threshold (p80 engagement_score): ${threshold}`);

  // 2. Get all social_post IDs above threshold. top_performer only exists on
  // social_posts, so a video_library_id-sourced row (2026-09-30) is
  // filtered out here rather than generating a no-op PATCH against
  // social_posts for an id that will never match.
  const { data: topRows, ok: topOk } = await supabaseFetch(
    `/rest/v1/post_analytics?engagement_score=gt.${threshold}&select=social_post_id`,
  );
  const topIds = topOk && Array.isArray(topRows)
    ? [...new Set(topRows.map((r) => r.social_post_id).filter(Boolean))]
    : [];

  // 3. Reset all top_performer flags, then set them for top performers
  //    Do this as two targeted patches rather than a full-table scan.
  if (topIds.length > 0) {
    // Clear all first (best-effort — non-fatal if it fails)
    await supabaseFetch(
      `/rest/v1/social_posts?status=eq.posted&top_performer=eq.true`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ top_performer: false }),
      },
    );
    // Set top performers via individual patches (PostgREST doesn't support
    // IN filters on PATCH in the free tier without RPC — iterate instead)
    let flagged = 0;
    for (const spId of topIds) {
      const enc = encodeURIComponent(spId);
      const r = await supabaseFetch(`/rest/v1/social_posts?id=eq.${enc}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ top_performer: true }),
      });
      if (r.ok) flagged++;
    }
    console.log(`[analytics-sync] flagged ${flagged} top performers (threshold=${threshold})`);
  }

  // ─── A/B test winner flagging ─────────────────────────────────────────────
  // For any ab_test_group_id where both variants are posted >=72h ago and
  // ab_test_winner is still NULL, set ab_test_winner=true on the higher-engagement
  // variant. This runs inside the analytics-sync so we use the freshest engagement_score.
  let abWinnersFlagged = 0;
  try {
    const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const { ok: abLoadOk, data: abRows } = await supabaseFetch(
      `/rest/v1/social_posts?ab_test_group_id=not.is.null&status=eq.posted&posted_at=lte.${encodeURIComponent(cutoff)}&ab_test_winner=eq.false&select=id,ab_test_group_id,variant,likes,comments,shares,clicks,views`,
    );
    if (abLoadOk && Array.isArray(abRows)) {
      const byGroup = new Map();
      for (const r of abRows) {
        if (!byGroup.has(r.ab_test_group_id)) byGroup.set(r.ab_test_group_id, []);
        byGroup.get(r.ab_test_group_id).push(r);
      }
      for (const [groupId, members] of byGroup.entries()) {
        if (members.length < 2) continue;

        // Generalized to N-way variant groups (was A/B-only): before declaring
        // a winner, confirm every member of this ab_test_group_id has actually
        // posted. Without this check, a 5-variant group where only 2 of 5 have
        // published (each individually >=72h old) would get a winner flagged
        // while 3 variants haven't even run yet.
        const { ok: groupCheckOk, data: groupRows } = await supabaseFetch(
          `/rest/v1/social_posts?ab_test_group_id=eq.${encodeURIComponent(groupId)}&select=id,status`,
        );
        if (!groupCheckOk || !Array.isArray(groupRows)) continue;
        const stillPending = groupRows.some((g) => g.status !== 'posted' && g.status !== 'failed' && g.status !== 'rejected');
        if (stillPending) continue; // wait for the full cohort to publish (or terminally fail/reject)

        const score = (r) => (r.likes || 0) * 1 + (r.comments || 0) * 3 + (r.shares || 0) * 5 + (r.clicks || 0) * 2;
        const winner = members.slice().sort((a, b) => score(b) - score(a))[0];
        if (!winner) continue;
        const { ok: winPatchOk } = await supabaseFetch(
          `/rest/v1/social_posts?id=eq.${encodeURIComponent(winner.id)}`,
          {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ ab_test_winner: true }),
          },
        );
        if (winPatchOk) {
          abWinnersFlagged++;
          // Notify Sage via her bot
          const TELEGRAM_SAGE_BOT_TOKEN = process.env.TELEGRAM_SAGE_BOT_TOKEN;
          const sageChatId = TELEGRAM_CHAT_ID;
          if (TELEGRAM_SAGE_BOT_TOKEN && sageChatId) {
            const msg = `[A/B WINNER] Group ${groupId.slice(0, 8)}: variant ${winner.variant} won (score ${score(winner)}). All variants: ${members.map((m) => `${m.variant}=${score(m)}`).join(', ')}.`;
            await fetch(`https://api.telegram.org/bot${TELEGRAM_SAGE_BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: sageChatId, text: msg }),
            }).catch(() => {});
            await supabaseFetch('/rest/v1/sage_conversations', {
              method: 'POST',
              headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({ chat_id: String(sageChatId), role: 'user', text: msg }),
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn('[analytics-sync] AB winner flagging failed:', err && err.message);
  }

  // ─── Telegram summary ─────────────────────────────────────────────────────
  const summaryLines = [
    '<b>Analytics Sync Complete</b>',
    '',
    `Zernio rows fetched: ${totalFetched}`,
    `Matched to our posts: ${totalMatched}`,
    `Upserted to post_analytics: ${totalUpserted}`,
    `zernio_post_id back-filled: ${totalBackfilled}`,
    `Top performers flagged: ${topIds.length}`,
    `Top-performer threshold: ${threshold}`,
  ];
  if (errors.length > 0) {
    summaryLines.push('', `Errors: ${errors.length}`);
    for (const e of errors.slice(0, 3)) {
      summaryLines.push(`- ${e.platform || e.post_id}: ${e.error}`);
    }
  }
  await sendTelegramSummary(summaryLines.join('\n'));

  return res.status(200).json({
    ok: true,
    sync_date: syncDate,
    fetched: totalFetched,
    matched: totalMatched,
    upserted: totalUpserted,
    backfilled: totalBackfilled,
    top_performers_flagged: topIds.length,
    top_performer_threshold: threshold,
    errors,
  });
});
