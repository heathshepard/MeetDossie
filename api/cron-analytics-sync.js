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

const { retryFetch } = require('./_lib/retry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const ZERNIO_BASE = 'https://zernio.com/api/v1';

// Account IDs from CLAUDE.md section 22
const ZERNIO_ACCOUNTS = [
  { platform: 'facebook',  accountId: '69f253c3985e734bf3d8f9bc' },
  { platform: 'instagram', accountId: '69f25431985e734bf3d8fcbe' },
  { platform: 'twitter',   accountId: '69f255c6985e734bf3d90ba1' },
  { platform: 'linkedin',  accountId: '69fccd7392b3d8e85f8f12be' },
  // TikTok omitted — inactive
];

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
}

// ─── Main handler ─────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
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
    `/rest/v1/social_posts?status=eq.posted&select=id,post_id,platform,zernio_post_id,posted_at,zernio_account_id&order=posted_at.desc&limit=500`,
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

  // Process each account
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

      if (!matchedRow) continue; // Zernio post we didn't publish (scheduled from Zernio UI, etc.)
      totalMatched++;

      // Upsert into post_analytics (one row per social_post per sync_date)
      const analyticsRow = {
        social_post_id: matchedRow.id,
        zernio_post_id: zId || matchedRow.zernio_post_id || null,
        platform: account.platform,
        persona: matchedRow.persona || null,
        topic: matchedRow.topic || null,
        hook: matchedRow.hook || null,
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

  // ─── Recompute top_performer flags ────────────────────────────────────────
  // 1. Compute 80th-percentile threshold across all synced rows
  const threshold = await computeTopPerformerThreshold();
  console.log(`[analytics-sync] top_performer threshold (p80 engagement_score): ${threshold}`);

  // 2. Get all social_post IDs above threshold
  const { data: topRows, ok: topOk } = await supabaseFetch(
    `/rest/v1/post_analytics?engagement_score=gt.${threshold}&select=social_post_id`,
  );
  const topIds = topOk && Array.isArray(topRows)
    ? [...new Set(topRows.map((r) => r.social_post_id))]
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
};
