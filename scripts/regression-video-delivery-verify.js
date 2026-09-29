#!/usr/bin/env node
'use strict';

/**
 * Regression test for Pipeline B delivery verification
 * (api/cron-verify-zernio-deliveries.js's verifyVideoLibraryDeliveries()).
 *
 * THE GAP (Carter, 2026-09-17)
 * -----------------------------------------------------------------------
 * Pipeline B (video_library -> api/cron-post-videos.js -> Zernio) had NO
 * delivery verification at all. cron-verify-posts.js and
 * cron-verify-zernio-deliveries.js both only covered social_posts rows —
 * a video_library row could post_result.ok from Zernio's accept call, get
 * marked status='posted', and then actually fail to deliver with nothing
 * ever noticing. Same silent-failure class as
 * feedback_silent-failure-is-the-enemy.md.
 *
 * WHAT THIS PINS DOWN
 * --------------------
 *   1. A video_library row whose Zernio delivery check comes back a hard
 *      failure gets a Telegram alert AND its zernio_deliveries entry is
 *      patched to status='failed' — it does not sit silently as 'posted'.
 *   2. A row still legitimately processing (not yet past the stale window)
 *      is left alone — no alert, no false-positive noise.
 *   3. telegram-gate's default-off switch does not eat this alert — this
 *      job is on the ALWAYS_ALLOW floor precisely because a swallowed
 *      delivery-failure alert recreates the exact bug being fixed here.
 *
 * All I/O (Supabase REST, Zernio, Telegram) is a single in-process
 * global.fetch mock keyed on URL — no real network, no real DB.
 *
 * Run manually:
 *   node scripts/regression-video-delivery-verify.js
 */

const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..');

async function main() {
  process.env.SUPABASE_URL = 'https://mock.supabase.local';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key';
  process.env.ZERNIO_API_KEY = 'mock-zernio-key';
  process.env.TELEGRAM_MARKETING_BOT_TOKEN = 'mock-telegram-token';
  process.env.TELEGRAM_CHAT_ID = '999';
  process.env.CRON_SECRET = 'mock-cron-secret';
  // Leave TELEGRAM_CRON_NOTIFICATIONS unset — this test's whole point is
  // that the alert survives the gate's default-off state via ALWAYS_ALLOW.
  delete process.env.TELEGRAM_CRON_NOTIFICATIONS;

  const telegramSends = [];
  const videoPatches = [];

  const NOW = Date.now();
  const FAILED_ENTRY_ACCEPTED_AT = new Date(NOW - 60 * 60 * 1000).toISOString(); // 1h ago
  const PROCESSING_ENTRY_ACCEPTED_AT = new Date(NOW - 5 * 60 * 1000).toISOString(); // 5min ago — well under the 3h stale window

  let videoLibraryRows = [
    {
      id: 'vid-failed-delivery',
      topic: 'Test video — never delivered',
      posted_date: new Date(NOW - 30 * 60 * 1000).toISOString(),
      status: 'posted',
      zernio_deliveries: [
        {
          platform: 'facebook',
          zernio_post_id: 'zpost-fails',
          scheduled_for: null,
          accepted_at: FAILED_ENTRY_ACCEPTED_AT,
          status: 'accepted',
          proof_level: 'unconfirmed',
          platform_url: null,
          verified_at: null,
          error: null,
          alerted_at: null,
        },
      ],
    },
    {
      id: 'vid-still-processing',
      topic: 'Test video — still processing, not stale yet',
      posted_date: new Date(NOW - 5 * 60 * 1000).toISOString(),
      status: 'posted',
      zernio_deliveries: [
        {
          platform: 'tiktok',
          zernio_post_id: 'zpost-processing',
          scheduled_for: null,
          accepted_at: PROCESSING_ENTRY_ACCEPTED_AT,
          status: 'accepted',
          proof_level: 'unconfirmed',
          platform_url: null,
          verified_at: null,
          error: null,
          alerted_at: null,
        },
      ],
    },
  ];

  const originalFetch = global.fetch;
  global.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = (init && init.method) || 'GET';

    // Supabase REST — video_library
    if (url.includes('/rest/v1/video_library')) {
      if (method === 'GET') {
        return new Response(JSON.stringify(videoLibraryRows), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'PATCH') {
        const body = init.body ? JSON.parse(init.body) : {};
        const idMatch = /id=eq\.([^&]+)/.exec(url);
        const id = idMatch ? decodeURIComponent(idMatch[1]) : null;
        videoPatches.push({ id, body });
        videoLibraryRows = videoLibraryRows.map((r) => (r.id === id ? { ...r, ...body } : r));
        return new Response(null, { status: 204 });
      }
    }

    // Zernio delivery-status check
    if (url.includes('zernio.com/api/v1/posts/zpost-fails')) {
      return new Response(JSON.stringify({ error: 'post_not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('zernio.com/api/v1/posts/zpost-processing')) {
      return new Response(JSON.stringify({ status: 'processing' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Telegram sends
    if (url.includes('api.telegram.org')) {
      const body = init.body ? JSON.parse(init.body) : {};
      telegramSends.push(body);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    throw new Error(`Unexpected fetch in regression test: ${method} ${url}`);
  };

  try {
    // Fresh require AFTER the env vars + fetch mock are in place, since the
    // module reads SUPABASE_URL/ZERNIO_API_KEY into top-level consts at
    // require time and telegram-gate.js wraps whatever global.fetch is
    // current at install() time.
    delete require.cache[require.resolve(path.join(REPO, 'api', 'cron-verify-zernio-deliveries.js'))];
    delete require.cache[require.resolve(path.join(REPO, 'api', '_lib', 'telegram-gate.js'))];
    const mod = require(path.join(REPO, 'api', 'cron-verify-zernio-deliveries.js'));
    const { verifyVideoLibraryDeliveries } = mod;
    assert.strictEqual(typeof verifyVideoLibraryDeliveries, 'function', 'verifyVideoLibraryDeliveries must be exported for regression coverage');

    const report = await verifyVideoLibraryDeliveries();

    // ── 1. Confirmed failure alerts, does not sit silently as 'posted' ──
    assert.strictEqual(report.summary.failed, 1, `expected 1 failed delivery, got ${JSON.stringify(report.summary)}`);
    const failureAlert = report.alerts.find((a) => a.video_id === 'vid-failed-delivery' && a.reason === 'delivery_failed');
    assert.ok(failureAlert, `expected a delivery_failed alert for vid-failed-delivery, got ${JSON.stringify(report.alerts)}`);

    const telegramFailureMsg = telegramSends.find((s) => String(s.text || '').includes('FAILED') && String(s.text || '').includes('vid-failed-delivery'));
    assert.ok(telegramFailureMsg, `expected a Telegram alert mentioning the failed video, got ${JSON.stringify(telegramSends)}`);

    const failedPatch = videoPatches.find((p) => p.id === 'vid-failed-delivery');
    assert.ok(failedPatch, 'expected a PATCH persisting the failed delivery entry');
    const patchedEntry = failedPatch.body.zernio_deliveries.find((e) => e.platform === 'facebook');
    assert.strictEqual(patchedEntry.status, 'failed', 'entry must be patched to status=failed, not left as accepted');
    assert.strictEqual(patchedEntry.verified_at, null, 'a failed entry must never carry a verified_at timestamp');
    console.log('  PASS: Zernio-confirmed delivery failure alerts Heath and patches the row — does not sit silently as posted');

    // ── 2. Still-processing, not yet stale — no false-positive alert ────
    const staleAlert = report.alerts.find((a) => a.video_id === 'vid-still-processing');
    assert.strictEqual(staleAlert, undefined, `a not-yet-stale processing entry must not alert, got ${JSON.stringify(staleAlert)}`);
    const processingPatch = videoPatches.find((p) => p.id === 'vid-still-processing');
    assert.strictEqual(processingPatch, undefined, 'a still-processing, not-stale row should not be patched at all this run');
    console.log('  PASS: still-processing delivery within the stale window does not false-positive alert');

    console.log('\nALL PASS');
  } finally {
    global.fetch = originalFetch;
  }
}

main().catch((err) => {
  console.error('REGRESSION FAILED:', err && err.stack || err);
  process.exit(1);
});
