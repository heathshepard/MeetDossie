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
// PIPELINE B COVERAGE (Carter, 2026-09-17): also verifies video_library rows
// (cron-post-videos.js -> Zernio). Previously ONLY social_posts was covered
// here and in cron-verify-posts.js — a scheduled video post could silently
// fail with nothing noticing (the same silent-failure class documented in
// memory feedback_silent-failure-is-the-enemy.md). See
// verifyVideoLibraryDeliveries() below and api/_lib/video-delivery-verify.js
// for the per-platform proof-level model (a video posts to several
// platforms at once, unlike a social_posts row which is one row per
// platform, so this needed its own jsonb-array tracking rather than reusing
// social_posts' single zernio_post_id column).
//
// Auth:     Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — every 30 min ("*/30 * * * *").

// Scheduled-Telegram kill switch (Atlas 2026-08-16). Gates unattended pushes
// to Heath behind TELEGRAM_CRON_NOTIFICATIONS. Two-way chat is unaffected.
require('./_lib/telegram-gate').install('cron-verify-zernio-deliveries');

const { recordCronRun } = require('./_lib/cron-telemetry.js');
const { checkZernioDeliveryStatus } = require('./_lib/zernio-post-status.js');
const {
  proofLevelFor,
  patchDeliveryEntry,
  isDueForStaleAlert,
  entriesNeedingCheck,
  entriesUnconfirmable,
} = require('./_lib/video-delivery-verify.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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

// --- Pipeline B: video_library delivery verification ---------------------
//
// A video_library row posts to several platforms at once (see
// cron-post-videos.js), so — unlike social_posts, which is one row per
// platform — the per-platform Zernio accept/confirm state lives in the
// row's `zernio_deliveries` jsonb array (api/_lib/video-delivery-verify.js
// documents the schema). This function:
//   1. Loads 'posted' video_library rows from the lookback window that have
//      at least one delivery entry still unresolved.
//   2. For entries with a zernio_post_id: polls Zernio, records the honest
//      proof_level (never claims a live-URL confirmation we didn't get —
//      see proofLevelFor()), and alerts immediately on a confirmed failure.
//   3. For entries with NO zernio_post_id (Zernio accepted the call but
//      gave nothing to poll) or still-processing entries: alerts once,
//      after DEFAULT_STALE_WINDOW_MS, instead of staying silent forever.
//
// VIDEO_LOOKBACK_MS is wider than social_posts' 2h window — video transcode
// (TikTok/YouTube especially) can legitimately take longer than a text/image
// post, and this cron runs every 30 min regardless, so a wider window just
// means more rows re-scanned, not slower alerting.
const VIDEO_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24h

async function verifyVideoLibraryDeliveries() {
  const now = new Date();
  const lookbackIso = new Date(now.getTime() - VIDEO_LOOKBACK_MS).toISOString();

  // Can't filter "an array element is missing verified_at" (or "the array
  // is non-empty") reliably in a PostgREST jsonb query, so pull all
  // recently-posted rows and filter client-side — video_library posts at
  // most a handful of times a day, so this is a small scan either way.
  const filter = `status=eq.posted&posted_date=gte.${encodeURIComponent(lookbackIso)}&order=posted_date.asc&select=id,topic,posted_date,zernio_deliveries`;
  const { data: rows, ok: loadOk } = await supabaseFetch(`/rest/v1/video_library?${filter}&limit=100`);

  if (!loadOk) {
    console.error('[cron-verify-zernio-deliveries] failed to load video_library rows');
    return { summary: { rows_checked: 0, error: 'load failed' }, alerts: [] };
  }

  const candidates = Array.isArray(rows) ? rows : [];
  let confirmed = 0;
  let failedCount = 0;
  let staleAlerted = 0;
  const alerts = [];

  for (const video of candidates) {
    const deliveries = Array.isArray(video.zernio_deliveries) ? video.zernio_deliveries : [];
    const toCheck = entriesNeedingCheck(deliveries);
    const unconfirmable = entriesUnconfirmable(deliveries);
    if (toCheck.length === 0 && unconfirmable.length === 0) continue;

    let working = deliveries;
    let rowChanged = false;

    for (const entry of toCheck) {
      // Pass the platform: a Zernio post fans out to several platforms and
      // this array tracks delivery per platform, so "did it publish" must be
      // answered for THIS platform, not for whichever entry Zernio lists first.
      const result = await checkZernioDeliveryStatus(entry.zernio_post_id, ZERNIO_API_KEY, entry.platform);

      if (result.ok && result.is_live) {
        const proof_level = proofLevelFor({ isLive: true, platformUrl: result.platform_url });
        working = patchDeliveryEntry(working, entry.platform, {
          status: 'confirmed',
          proof_level,
          platform_url: result.platform_url || entry.platform_url || null,
          verified_at: now.toISOString(),
          error: null,
        });
        rowChanged = true;
        confirmed++;
        console.log(`[cron-verify-zernio-deliveries] video ${video.id} ${entry.platform}: confirmed (${proof_level})`);
      } else if (result.ok && !result.is_live) {
        // Still processing at Zernio — not a failure yet. Alert once if
        // it's been unresolved past the stale window; keep polling either way.
        if (isDueForStaleAlert({ entry, nowIso: now.toISOString() })) {
          const msg = `⚠️ <b>Video delivery unconfirmed</b>\n\nVideo ${video.id} (${video.topic || 'untitled'}) — ${entry.platform} still shows "${result.zernio_status || 'processing'}" at Zernio ${Math.round((Date.now() - Date.parse(entry.accepted_at)) / 3600000)}h after posting. Check the platform/Zernio dashboard directly.`;
          await sendTelegramAlert(msg);
          alerts.push({ video_id: video.id, platform: entry.platform, reason: 'stale_unconfirmed' });
          working = patchDeliveryEntry(working, entry.platform, { alerted_at: now.toISOString() });
          rowChanged = true;
          staleAlerted++;
        }
      } else {
        // Zernio explicitly reports failure/error — this is the case the
        // regression test locks in: a Pipeline B row Zernio never delivered
        // must alert, not sit silently as 'posted'.
        const errorMsg = result.error || 'Zernio delivery check failed';
        working = patchDeliveryEntry(working, entry.platform, {
          status: 'failed',
          proof_level: proofLevelFor({ isLive: false, platformUrl: null }),
          verified_at: null,
          error: errorMsg,
          alerted_at: now.toISOString(),
        });
        rowChanged = true;
        failedCount++;
        const msg = `🚨 <b>Video delivery FAILED</b>\n\nVideo ${video.id} (${video.topic || 'untitled'}) — ${entry.platform} was marked posted but Zernio never delivered it.\n\nError: ${String(errorMsg).slice(0, 300)}`;
        await sendTelegramAlert(msg);
        alerts.push({ video_id: video.id, platform: entry.platform, reason: 'delivery_failed', error: errorMsg });
      }
    }

    // Entries Zernio never gave us an id for at all — can't poll, so the
    // only guard is staleness alerting.
    for (const entry of unconfirmable) {
      if (isDueForStaleAlert({ entry, nowIso: now.toISOString() })) {
        const msg = `⚠️ <b>Video delivery unverifiable</b>\n\nVideo ${video.id} (${video.topic || 'untitled'}) — ${entry.platform} was accepted by Zernio with no post id to check, ${Math.round((Date.now() - Date.parse(entry.accepted_at)) / 3600000)}h ago. Cannot confirm delivery automatically — check the platform directly.`;
        await sendTelegramAlert(msg);
        alerts.push({ video_id: video.id, platform: entry.platform, reason: 'unconfirmable_stale' });
        working = patchDeliveryEntry(working, entry.platform, { alerted_at: now.toISOString() });
        rowChanged = true;
        staleAlerted++;
      }
    }

    if (rowChanged) {
      await supabaseFetch(`/rest/v1/video_library?id=eq.${encodeURIComponent(video.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ zernio_deliveries: working }),
      });
    }
  }

  console.log(`[cron-verify-zernio-deliveries] video_library: ${candidates.length} rows checked, ${confirmed} confirmed, ${failedCount} failed, ${staleAlerted} stale-alerted`);

  return {
    summary: { rows_checked: candidates.length, confirmed, failed: failedCount, stale_alerted: staleAlerted },
    alerts,
  };
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

      const result = await checkZernioDeliveryStatus(post.zernio_post_id, ZERNIO_API_KEY);

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

    // Pipeline B: video_library delivery verification (see file header).
    const videoReport = await verifyVideoLibraryDeliveries();

    await recordCronRun('cron-verify-zernio-deliveries', 'ok', {
      unverified_checked: queue.length,
      verified,
      failed,
      failure_rate_24h: (failureRate * 100).toFixed(1),
      video_library: videoReport.summary,
    });

    return res.status(200).json({
      ok: true,
      unverified_checked: queue.length,
      verified,
      failed,
      failure_rate_24h: (failureRate * 100).toFixed(1),
      failures,
      video_library: videoReport,
    });
  } catch (e) {
    console.error('[cron-verify-zernio-deliveries] crashed:', e);
    await recordCronRun('cron-verify-zernio-deliveries', 'error', { error: e.message });
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// Exposed for regression coverage (scripts/regression-video-delivery-verify.js)
// so the video_library path can be exercised directly without spinning up a
// full request/response cycle or the social_posts side of this handler.
module.exports.verifyVideoLibraryDeliveries = verifyVideoLibraryDeliveries;
