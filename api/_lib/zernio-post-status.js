'use strict';

// api/_lib/zernio-post-status.js
//
// Extracted from cron-verify-zernio-deliveries.js (Carter, 2026-09-17) so
// Pipeline B (video_library) verification can reuse the exact same Zernio
// GET /posts/:id parsing instead of a second, drifting copy. Logic is
// unchanged from the original inline function.

const { retryFetch } = require('./retry.js');

const ZERNIO_POSTS_API = 'https://zernio.com/api/v1/posts';

// Query Zernio API to check delivery status of a scheduled/published post.
// `wantPlatform` is optional: when supplied, the returned status/url describe
// THAT platform's entry on a multi-platform post rather than the first one.
async function checkZernioDeliveryStatus(zernioPostId, apiKey, wantPlatform = null) {
  try {
    const res = await retryFetch(
      `${ZERNIO_POSTS_API}/${encodeURIComponent(zernioPostId)}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
      },
      { name: 'Zernio-status-check', maxAttempts: 3, baseDelay: 1000 },
    );

    const respText = await res.text();
    let data = null;
    try { data = respText ? JSON.parse(respText) : null; } catch { data = null; }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `Zernio ${res.status}: ${respText.slice(0, 300)}`,
        data,
      };
    }

    // Extract post status and platform URLs from Zernio's response.
    //
    // THE REAL SHAPE (verified live 2026-09-25, Atlas, against a genuinely
    // published YouTube post — GET /v1/posts/:id returns):
    //   { post: { status: 'published',
    //             platforms: [ { platform, status, platformPostId,
    //                            platformPostUrl, publishedAt, error } ] } }
    //
    // The speculative shapes this function was originally written against
    // (`platform_urls`, top-level `status`, `posts[]`, `platforms[].url`)
    // are NOT what Zernio sends. The envelope is `data.post`, so `status`
    // resolved to undefined and `platforms` to [] on every single call —
    // is_live was therefore ALWAYS false. Nothing could ever be confirmed:
    // every genuinely delivered post sat at proof_level 'unconfirmed' until
    // the stale window fired a false "delivery unconfirmed" alert. Kept the
    // legacy fallbacks below so nothing regresses if Zernio ever returns one
    // of them, but `data.post` is checked first because it's the real one.
    const postData = data?.post
      || (Array.isArray(data?.posts) ? data.posts[0] : null)
      || data;

    const platforms = Array.isArray(postData?.platforms) ? postData.platforms : [];
    // Optional per-platform targeting: a Zernio post can fan out to several
    // platforms, and Pipeline B tracks delivery per platform. When the caller
    // names one, report THAT platform's state rather than the first entry's.
    const entry = wantPlatform
      ? platforms.find((p) => String(p?.platform || '').toLowerCase() === String(wantPlatform).toLowerCase())
      : platforms[0];

    const status = entry?.status || postData?.status || data?.status;

    const platformUrls = postData?.platform_urls || data?.platform_urls || {};
    let mainPlatformUrl =
      entry?.platformPostUrl
      || entry?.url
      || null;
    if (!mainPlatformUrl && Object.keys(platformUrls).length > 0) {
      mainPlatformUrl = wantPlatform
        ? (platformUrls[wantPlatform] || Object.values(platformUrls)[0])
        : Object.values(platformUrls)[0];
    }

    const isLive = status === 'published' || status === 'live' || status === 'posted';

    return {
      ok: true,
      status: res.status,
      data,
      zernio_status: status,
      is_live: isLive,
      platform_url: mainPlatformUrl,
      platform_post_id: entry?.platformPostId || null,
      platform_error: entry?.error || null,
    };
  } catch (err) {
    const errorMsg = err && err.message ? `Zernio exception: ${err.message}` : 'No response from Zernio';
    console.error(`[checkZernioDeliveryStatus] ${zernioPostId}: ${errorMsg}`);
    return {
      ok: false,
      error: errorMsg,
    };
  }
}

module.exports = { checkZernioDeliveryStatus, ZERNIO_POSTS_API };
