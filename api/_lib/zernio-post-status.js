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
async function checkZernioDeliveryStatus(zernioPostId, apiKey) {
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

    // Extract post status and platform URLs from Zernio response.
    // Response shape varies — look for common patterns:
    //   { status, platform_urls: { twitter: 'url', ... }, ... }
    //   { posts: [ { status, platform_urls, ... } ] }
    //   { id, platforms: [ { platform, url, status } ] }
    const postData = Array.isArray(data?.posts)
      ? data.posts[0]
      : data?.posts
      ? data
      : data;

    const status = postData?.status || data?.status;
    const platformUrls = postData?.platform_urls || data?.platform_urls || {};
    const platforms = Array.isArray(postData?.platforms) ? postData.platforms : [];

    // Infer main platform URL from the response
    let mainPlatformUrl = null;
    if (Object.keys(platformUrls).length > 0) {
      mainPlatformUrl = Object.values(platformUrls)[0];
    } else if (platforms.length > 0) {
      mainPlatformUrl = platforms[0].url;
    }

    const isLive = status === 'published' || status === 'live' || status === 'posted';

    return {
      ok: true,
      status: res.status,
      data,
      zernio_status: status,
      is_live: isLive,
      platform_url: mainPlatformUrl,
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
