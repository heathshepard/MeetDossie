#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-07 cron-post-videos schedule/cap fix
 * (docs/FEATURE-VIDEO-DAILY-PLAN.md §3, bugs 1 + 2).
 *
 * THE BUGS
 * --------
 * 1. getPlatformsPostedToday() was defined but NEVER CALLED — per-platform
 *    daily caps from posting_schedule were not enforced at all. At daily
 *    video volume across 4 platforms that risks platform rate limits and
 *    account flags.
 * 2. The cron ignored posting_schedule entirely: publishNow at 13:30 UTC to
 *    every platform on the row, including platforms whose schedule row is
 *    INACTIVE (twitter, youtube).
 *
 * THE FIX
 * -------
 * Every platform is gated through the live posting_schedule table:
 *   - row inactive or missing for today  → platform skipped (logged)
 *   - daily cap reached (social_posts + video_library posted today)
 *                                        → platform skipped (logged)
 *   - otherwise Zernio gets scheduledFor = next slot today, or
 *     publishNow when every slot has already passed
 *
 * TESTS (local mock PostgREST + intercepted Zernio/Telegram — ZERO
 * production access, ZERO real posts):
 *   1. CAP: facebook is at its daily cap (2/2) → NO Zernio call for facebook.
 *   2. INACTIVE: twitter's schedule row is is_active=false → NO Zernio call
 *      for twitter, and the skip is reported with an "inactive" reason.
 *   3. Eligible platforms still post: linkedin (slots all passed) fires with
 *      publishNow:true; instagram (slot still ahead) fires with scheduledFor
 *      and NO publishNow.
 *   4. The video row still ends up status='posted' for the eligible subset.
 *
 * Run manually:
 *   node scripts/regression-post-videos-schedule-caps.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');
const VIDEO_ID = 'regr-video-schedcap-0001';

// Schedule fixture: rows for every day_of_week so the test is day-agnostic.
// linkedin slot 00:00 => always in the past => publishNow expected.
// instagram slot 23:59 => (almost) always in the future => scheduledFor expected.
function scheduleRows() {
  const rows = [];
  for (let dow = 0; dow < 7; dow++) {
    rows.push(
      { platform: 'facebook',  day_of_week: dow, time_slots: ['09:00:00', '14:00:00'], timezone: 'America/Chicago', is_active: true,  max_per_day: 2, max_per_slot: 1 },
      { platform: 'twitter',   day_of_week: dow, time_slots: ['08:00:00'],             timezone: 'America/Chicago', is_active: false, max_per_day: 3, max_per_slot: 1 },
      { platform: 'linkedin',  day_of_week: dow, time_slots: ['00:00:00'],             timezone: 'America/Chicago', is_active: true,  max_per_day: 2, max_per_slot: null },
      { platform: 'instagram', day_of_week: dow, time_slots: ['23:59:00'],             timezone: 'America/Chicago', is_active: true,  max_per_day: 2, max_per_slot: 1 },
      { platform: 'tiktok',    day_of_week: dow, time_slots: ['07:00:00', '19:00:00'], timezone: 'America/Chicago', is_active: true,  max_per_day: 1, max_per_slot: 1 },
    );
  }
  return rows;
}

const patches = []; // { table, query, body }

function startMockSupabase() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const url = new URL(req.url, 'http://localhost');
        const table = url.pathname.split('/').pop();
        const q = url.search || '';

        if (req.method === 'PATCH') {
          let body = null;
          try { body = JSON.parse(raw); } catch { body = raw; }
          patches.push({ table, query: q, body });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('[{}]'); // return=representation callers need a non-empty array
          return;
        }

        const json = (obj) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(obj));
        };

        if (req.method === 'GET' && table === 'video_library') {
          if (q.includes('status=eq.heath_approved')) {
            return json([{
              id: VIDEO_ID,
              status: 'heath_approved',
              topic: 'schedule/cap regression harness',
              platforms: ['facebook', 'twitter', 'linkedin', 'instagram'],
              caption: 'Regression harness caption for schedule and cap gating.',
              supabase_url: 'https://example.com/storage/v1/object/public/videos/regr.mp4',
            }]);
          }
          return json([]); // status=eq.approved, status=eq.posted (cap count)
        }

        if (req.method === 'GET' && table === 'posting_schedule') {
          return json(scheduleRows());
        }

        if (req.method === 'GET' && table === 'social_posts') {
          // Facebook already at its daily cap of 2 (two text posts today).
          return json([{ platform: 'facebook' }, { platform: 'facebook' }]);
        }

        if (req.method === 'GET' && table === 'zernio_accounts') {
          return json([{ page_id: '111222333444555', zernio_account_id: 'regr-acct' }]);
        }

        // skit_queue, telemetry, anything else: absorb.
        json([]);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function fakeReqRes() {
  const req = { headers: { 'x-vercel-cron': '1' }, query: {} };
  let statusCode = null;
  let jsonBody = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(obj) { jsonBody = obj; return this; },
    setHeader() { return this; },
    end() { return this; },
    get result() { return { statusCode, jsonBody }; },
  };
  return { req, res };
}

// --------------------------------------------------------------------- main
(async () => {
  const failures = [];
  const check = (name, fn) => {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (err) { failures.push(name); console.error(`  FAIL  ${name}\n        ${err.message}`); }
  };

  const server = await startMockSupabase();
  const port = server.address().port;

  // Env BEFORE any require. Telegram gate suppresses (var unset) — no real sends.
  delete process.env.TELEGRAM_CRON_NOTIFICATIONS;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'regr-dummy-key';
  process.env.ZERNIO_API_KEY = 'regr-dummy-zernio-key';
  process.env.TELEGRAM_BOT_TOKEN = 'regr-dummy-token';
  process.env.TELEGRAM_CHAT_ID = '111111';
  process.env.CRON_SECRET = 'regr-dummy-secret';

  const handler = require(path.join(REPO, 'api', 'cron-post-videos.js'));

  // Intercept Zernio on top of whatever wrappers the handler installed.
  const zernioCalls = []; // { url, payload }
  const underlyingFetch = globalThis.fetch;
  globalThis.fetch = async function interceptedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('zernio.com')) {
      let payload = null;
      try { payload = JSON.parse(init && init.body); } catch { payload = null; }
      zernioCalls.push({ url, payload });
      return new Response(JSON.stringify({ post: { _id: `zn-${zernioCalls.length}` } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return underlyingFetch(input, init);
  };

  const { req, res } = fakeReqRes();
  await handler(req, res);
  globalThis.fetch = underlyingFetch;
  server.close();

  const body = res.result.jsonBody || {};
  const calledPlatforms = zernioCalls
    .map((c) => c.payload && c.payload.platforms && c.payload.platforms[0] && c.payload.platforms[0].platform)
    .filter(Boolean);
  const callFor = (p) => zernioCalls.find(
    (c) => c.payload && c.payload.platforms && c.payload.platforms[0] && c.payload.platforms[0].platform === p,
  );

  console.log(`\nZernio calls observed: [${calledPlatforms.join(', ')}]`);
  console.log(`Handler response: ${JSON.stringify(body).slice(0, 400)}\n`);

  console.log('Test 1: daily cap must block the platform');
  check('facebook (at cap 2/2) got NO Zernio call', () => {
    assert.ok(!calledPlatforms.includes('facebook'),
      `facebook is at its posting_schedule daily cap (2/2) but the cron still posted to it — cap enforcement is not wired in`);
  });

  console.log('\nTest 2: inactive schedule row must be skipped, and say so');
  check('twitter (inactive row) got NO Zernio call', () => {
    assert.ok(!calledPlatforms.includes('twitter'),
      `twitter's posting_schedule row is is_active=false but the cron still posted to it`);
  });
  check('twitter skip is reported with an inactive reason', () => {
    const skips = (body.summary && body.summary.platform_skips) || [];
    const tw = skips.find((s) => s.platform === 'twitter');
    assert.ok(tw, `no platform_skips entry for twitter in response summary: ${JSON.stringify(body.summary)}`);
    assert.ok(/inactive/i.test(tw.reason), `twitter skip reason does not mention inactive: ${tw.reason}`);
  });

  console.log('\nTest 3: eligible platforms still post, honoring slots');
  check('exactly linkedin + instagram were posted', () => {
    assert.deepStrictEqual([...calledPlatforms].sort(), ['instagram', 'linkedin'],
      `expected Zernio calls for exactly [instagram, linkedin], got [${calledPlatforms.join(', ')}]`);
  });
  check('linkedin (all slots passed) uses publishNow:true', () => {
    const c = callFor('linkedin');
    assert.ok(c, 'no Zernio call for linkedin');
    assert.strictEqual(c.payload.publishNow, true, `linkedin payload: ${JSON.stringify(c.payload)}`);
    assert.ok(!c.payload.scheduledFor, 'linkedin should not carry scheduledFor');
  });
  check('instagram (23:59 slot ahead) uses scheduledFor, not publishNow', () => {
    const c = callFor('instagram');
    assert.ok(c, 'no Zernio call for instagram');
    assert.ok(c.payload.scheduledFor, `instagram payload has no scheduledFor: ${JSON.stringify(c.payload)}`);
    assert.ok(!c.payload.publishNow, 'instagram must not also carry publishNow');
  });

  console.log('\nTest 4: row lifecycle');
  check("video row ends status='posted'", () => {
    const vp = patches.filter((p) => p.table === 'video_library' && p.query.includes(encodeURIComponent(VIDEO_ID)));
    const statuses = vp.map((p) => p.body && p.body.status).filter(Boolean);
    assert.strictEqual(statuses[statuses.length - 1], 'posted',
      `expected final status 'posted', PATCH statuses were: ${JSON.stringify(statuses)}`);
  });

  console.log('');
  if (failures.length) {
    console.error(`RESULT: FAIL (${failures.length} failing)`);
    process.exit(1);
  }
  console.log('RESULT: PASS');
  process.exit(0);
})().catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
