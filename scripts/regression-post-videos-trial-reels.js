#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-10-05 Instagram Trial Reels wiring in
 * api/cron-post-videos.js — postToZernio() must default every
 * target_owner='dossie' Instagram post to a Trial Reel
 * (platformSpecificData.trialParams.graduationStrategy='SS_PERFORMANCE'),
 * honor the per-row opt-out (video_library.ig_trial_reel_opt_out), and
 * NEVER apply it to owner='heath-realtor' (that account already has 982
 * followers — Trial Reels solve a cold-start problem it doesn't have).
 *
 * Field names verified against docs.zernio.com/platforms/instagram
 * (2026-10-05): trialParams / graduationStrategy, camelCase, matching
 * Zernio's platformSpecificData convention elsewhere in this file
 * (instagramThumbnail, pageId, tiktokSettings).
 *
 * TESTS (local mock PostgREST + intercepted Zernio — ZERO production
 * access, ZERO real posts):
 *   1. A heath_approved dossie video posting to instagram gets
 *      trialParams.graduationStrategy='SS_PERFORMANCE'.
 *   2. The same video's facebook call carries NO trialParams (Instagram-only
 *      field).
 *   3. A dossie video with ig_trial_reel_opt_out=true gets NO trialParams.
 *   4. A heath-realtor video posting to instagram gets NO trialParams, even
 *      without an opt-out column on that row.
 *
 * Run manually:
 *   node scripts/regression-post-videos-trial-reels.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');

function scheduleRows() {
  const rows = [];
  for (let dow = 0; dow < 7; dow++) {
    for (const platform of ['facebook', 'instagram', 'tiktok']) {
      rows.push({ platform, day_of_week: dow, time_slots: ['00:00:00'], timezone: 'America/Chicago', is_active: true, max_per_day: 10, max_per_slot: null });
    }
  }
  return rows;
}

const ZERNIO_ACCOUNTS_TABLE = [
  { platform: 'facebook', owner: 'dossie', zernio_account_id: 'dossie-fb-acct', page_id: 'dossie-fb-page' },
  { platform: 'instagram', owner: 'dossie', zernio_account_id: 'dossie-ig-acct', page_id: null },
  { platform: 'facebook', owner: 'heath-realtor', zernio_account_id: 'realtor-fb-acct', page_id: 'realtor-fb-page' },
  { platform: 'instagram', owner: 'heath-realtor', zernio_account_id: 'realtor-ig-acct', page_id: null },
];

function startMockSupabase(videoRow) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const table = url.pathname.split('/').pop();
      const q = url.search || '';

      if (req.method === 'PATCH') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[{}]');
        return;
      }

      const json = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (req.method === 'GET' && table === 'video_library') {
        if (q.includes('status=eq.heath_approved')) return json([videoRow]);
        return json([]);
      }

      if (req.method === 'GET' && table === 'posting_schedule') return json(scheduleRows());
      if (req.method === 'GET' && table === 'social_posts') return json([]);

      if (req.method === 'GET' && table === 'zernio_accounts') {
        const params = new URLSearchParams(q);
        const platform = (params.get('platform') || '').replace('eq.', '');
        const owner = (params.get('owner') || '').replace('eq.', '');
        const selectField = q.includes('select=page_id') ? 'page_id' : 'zernio_account_id';
        const row = ZERNIO_ACCOUNTS_TABLE.find((r) => r.platform === platform && r.owner === owner);
        if (!row) return json([]);
        return json([{ [selectField]: row[selectField] }]);
      }

      json([]);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server })));
}

async function runOnce(videoRow) {
  const { server } = await startMockSupabase(videoRow);
  const port = server.address().port;

  delete process.env.TELEGRAM_CRON_NOTIFICATIONS;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'regr-dummy-key';
  process.env.ZERNIO_API_KEY = 'regr-dummy-zernio-key';
  process.env.TELEGRAM_BOT_TOKEN = 'regr-dummy-token';
  process.env.TELEGRAM_CHAT_ID = '111111';
  process.env.CRON_SECRET = 'regr-dummy-secret';

  delete require.cache[require.resolve(path.join(REPO, 'api', 'cron-post-videos.js'))];
  const handler = require(path.join(REPO, 'api', 'cron-post-videos.js'));

  const zernioCalls = [];
  const underlyingFetch = globalThis.fetch;
  globalThis.fetch = async function interceptedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('zernio.com')) {
      let payload = null;
      try { payload = JSON.parse(init && init.body); } catch { payload = null; }
      zernioCalls.push({ payload });
      return new Response(JSON.stringify({ post: { _id: `zn-${zernioCalls.length}` } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return underlyingFetch(input, init);
  };

  const req = { headers: { 'x-vercel-cron': '1' }, query: {} };
  let statusCode = null; let jsonBody = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(obj) { jsonBody = obj; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
  await handler(req, res);
  globalThis.fetch = underlyingFetch;
  server.close();

  return { statusCode, jsonBody, zernioCalls };
}

(async () => {
  const failures = [];
  const check = (name, fn) => {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (err) { failures.push(name); console.error(`  FAIL  ${name}\n        ${err.message}`); }
  };

  console.log('Test 1+2: dossie video defaults to a Trial Reel on instagram, not facebook');
  {
    const { zernioCalls } = await runOnce({
      id: 'regr-trial-reel-0001',
      status: 'heath_approved',
      topic: 'trial reel default',
      target_owner: 'dossie',
      platforms: ['facebook', 'instagram'],
      caption: 'Every TREC deadline, cited to the paragraph.',
      supabase_url: 'https://example.com/storage/v1/object/public/videos/regr-trial-1.mp4',
      quality_status: 'passed',
      ig_trial_reel_opt_out: false,
    });

    const igCall = zernioCalls.find((c) => c.payload?.platforms?.[0]?.platform === 'instagram');
    const fbCall = zernioCalls.find((c) => c.payload?.platforms?.[0]?.platform === 'facebook');

    check('instagram call carries trialParams.graduationStrategy=SS_PERFORMANCE', () => {
      assert.ok(igCall, 'no instagram Zernio call made');
      assert.strictEqual(
        igCall.payload.platforms[0].platformSpecificData?.trialParams?.graduationStrategy,
        'SS_PERFORMANCE',
        `got: ${JSON.stringify(igCall.payload.platforms[0])}`,
      );
    });
    check('facebook call carries no trialParams (instagram-only field)', () => {
      assert.ok(fbCall, 'no facebook Zernio call made');
      assert.strictEqual(fbCall.payload.platforms[0].platformSpecificData?.trialParams, undefined,
        `got: ${JSON.stringify(fbCall.payload.platforms[0])}`);
    });
  }

  console.log('\nTest 3: ig_trial_reel_opt_out=true suppresses trialParams');
  {
    const { zernioCalls } = await runOnce({
      id: 'regr-trial-reel-0002',
      status: 'heath_approved',
      topic: 'trial reel opt out',
      target_owner: 'dossie',
      platforms: ['instagram'],
      caption: 'Opted out of the Trial Reel lane.',
      supabase_url: 'https://example.com/storage/v1/object/public/videos/regr-trial-2.mp4',
      quality_status: 'passed',
      ig_trial_reel_opt_out: true,
    });

    const igCall = zernioCalls.find((c) => c.payload?.platforms?.[0]?.platform === 'instagram');
    check('instagram call carries no trialParams when opted out', () => {
      assert.ok(igCall, 'no instagram Zernio call made');
      assert.strictEqual(igCall.payload.platforms[0].platformSpecificData?.trialParams, undefined,
        `got: ${JSON.stringify(igCall.payload.platforms[0])}`);
    });
  }

  console.log('\nTest 4: heath-realtor video never gets a Trial Reel (no cold-start problem there)');
  {
    const { zernioCalls } = await runOnce({
      id: 'regr-trial-reel-0003',
      status: 'heath_approved',
      topic: 'realtor instagram post',
      target_owner: 'heath-realtor',
      platforms: ['instagram'],
      caption: 'Heath Shepard, REALTOR - Keller Williams City-View.',
      supabase_url: 'https://example.com/storage/v1/object/public/videos/regr-trial-3.mp4',
      quality_status: 'passed',
    });

    const igCall = zernioCalls.find((c) => c.payload?.platforms?.[0]?.platform === 'instagram');
    check('heath-realtor instagram call carries no trialParams', () => {
      assert.ok(igCall, 'no instagram Zernio call made');
      assert.strictEqual(igCall.payload.platforms[0].platformSpecificData?.trialParams, undefined,
        `got: ${JSON.stringify(igCall.payload.platforms[0])}`);
    });
  }

  console.log(`\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S)`}`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
