#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-10 weekly-recording-kit GAP 4 fix to
 * api/cron-post-videos.js — video_library rows now carry target_owner
 * ('dossie' | 'heath-realtor') and must route to the matching Zernio
 * account, never the other owner's.
 *
 * THE BUG
 * -------
 * cron-post-videos.js's ZERNIO_ACCOUNTS map was hardcoded to Dossie's own
 * account IDs for every platform, with no way to route a video to Heath's
 * personal realtor Facebook/Instagram (owner='heath-realtor' in
 * zernio_accounts, live since 2026-08-18/08-25 per docs/PIPELINE.md).
 *
 * THE FIX
 * -------
 * postToZernio() now resolves the Zernio account via an owner-aware
 * zernio_accounts table lookup (mirrors cron-publish-approved.js), falling
 * back to the legacy hardcoded map ONLY for owner='dossie'. A
 * 'heath-realtor' platform with no zernio_accounts row (tiktok/twitter/
 * linkedin — not connected on Heath's Brokerage profile) fails that
 * platform explicitly instead of silently posting through Dossie's account.
 *
 * TESTS (local mock PostgREST + intercepted Zernio/Telegram — ZERO
 * production access, ZERO real posts):
 *   1. A heath_approved video with target_owner='heath-realtor' and
 *      platforms=[facebook, instagram] posts using the heath-realtor
 *      zernio_account_id for BOTH platforms — never Dossie's.
 *   2. The same row's Facebook post carries the heath-realtor page_id, not
 *      Dossie's.
 *   3. A heath_approved video with target_owner='dossie' (or unset) still
 *      posts using Dossie's account IDs — no regression on the existing
 *      lane.
 *   4. A heath-realtor row that also lists 'tiktok' (not connected for that
 *      owner) fails ONLY that platform, and the failure never silently
 *      substitutes Dossie's tiktok account.
 *
 * Run manually:
 *   node scripts/regression-post-videos-target-owner-routing.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');

// One shared schedule fixture: every platform active, slot far in the past
// so every post uses publishNow:true (keeps assertions simple).
function scheduleRows() {
  const rows = [];
  for (let dow = 0; dow < 7; dow++) {
    for (const platform of ['facebook', 'instagram', 'tiktok']) {
      rows.push({ platform, day_of_week: dow, time_slots: ['00:00:00'], timezone: 'America/Chicago', is_active: true, max_per_day: 10, max_per_slot: null });
    }
  }
  return rows;
}

// zernio_accounts fixture: dossie has facebook/instagram/tiktok; heath-realtor
// only has facebook/instagram (matches the real live state in docs/PIPELINE.md
// — no tiktok connected on the Brokerage profile).
const ZERNIO_ACCOUNTS_TABLE = [
  { platform: 'facebook', owner: 'dossie', zernio_account_id: 'dossie-fb-acct', page_id: 'dossie-fb-page' },
  { platform: 'instagram', owner: 'dossie', zernio_account_id: 'dossie-ig-acct', page_id: null },
  { platform: 'tiktok', owner: 'dossie', zernio_account_id: 'dossie-tt-acct', page_id: null },
  { platform: 'facebook', owner: 'heath-realtor', zernio_account_id: 'realtor-fb-acct', page_id: 'realtor-fb-page' },
  { platform: 'instagram', owner: 'heath-realtor', zernio_account_id: 'realtor-ig-acct', page_id: null },
];

function startMockSupabase(videoRow) {
  const patches = [];
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
        res.end('[{}]');
        return;
      }

      const json = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (req.method === 'GET' && table === 'video_library') {
        if (q.includes('status=eq.heath_approved')) return json([videoRow]);
        return json([]); // status=eq.approved, status=eq.posted (cap count)
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, patches })));
}

async function runOnce(videoRow) {
  const { server, patches } = await startMockSupabase(videoRow);
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

  const zernioCalls = []; // { payload }
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

  return { statusCode, jsonBody, zernioCalls, patches };
}

// --------------------------------------------------------------------- main
(async () => {
  const failures = [];
  const check = (name, fn) => {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (err) { failures.push(name); console.error(`  FAIL  ${name}\n        ${err.message}`); }
  };

  console.log('Test 1+2: heath-realtor video routes to Heath\'s own accounts');
  {
    const { zernioCalls } = await runOnce({
      id: 'regr-realtor-video-0001',
      status: 'heath_approved',
      topic: 'option period waive',
      target_owner: 'heath-realtor',
      platforms: ['facebook', 'instagram'],
      caption: 'Waiving your option period isnt always a bad idea. Heath Shepard, REALTOR - Keller Williams City-View.',
      supabase_url: 'https://example.com/storage/v1/object/public/videos/regr-realtor.mp4',
    });

    const fbCall = zernioCalls.find((c) => c.payload?.platforms?.[0]?.platform === 'facebook');
    const igCall = zernioCalls.find((c) => c.payload?.platforms?.[0]?.platform === 'instagram');

    check('facebook call used the heath-realtor account, not dossie\'s', () => {
      assert.ok(fbCall, 'no facebook Zernio call made');
      assert.strictEqual(fbCall.payload.platforms[0].accountId, 'realtor-fb-acct',
        `expected realtor-fb-acct, got ${fbCall.payload.platforms[0].accountId}`);
    });
    check('facebook call pinned the heath-realtor page_id, not dossie\'s', () => {
      assert.strictEqual(fbCall.payload.platforms[0].platformSpecificData?.pageId, 'realtor-fb-page',
        `got: ${JSON.stringify(fbCall.payload.platforms[0])}`);
    });
    check('instagram call used the heath-realtor account, not dossie\'s', () => {
      assert.ok(igCall, 'no instagram Zernio call made');
      assert.strictEqual(igCall.payload.platforms[0].accountId, 'realtor-ig-acct',
        `expected realtor-ig-acct, got ${igCall.payload.platforms[0].accountId}`);
    });
    check('no Zernio call anywhere used a dossie-* account for this heath-realtor video', () => {
      const offender = zernioCalls.find((c) => String(c.payload?.platforms?.[0]?.accountId || '').startsWith('dossie-'));
      assert.ok(!offender, `a heath-realtor video posted through a Dossie account: ${JSON.stringify(offender)}`);
    });
  }

  console.log('\nTest 3: dossie video (target_owner unset/dossie) is unaffected — no regression');
  {
    const { zernioCalls } = await runOnce({
      id: 'regr-dossie-video-0001',
      status: 'heath_approved',
      topic: 'tc went dark',
      target_owner: 'dossie',
      platforms: ['facebook', 'instagram', 'tiktok'],
      caption: 'A TC went dark on me mid-deal. Comment TC and I will send you what I built.',
      supabase_url: 'https://example.com/storage/v1/object/public/videos/regr-dossie.mp4',
    });

    check('all three platforms used dossie-* accounts', () => {
      const accountIds = zernioCalls.map((c) => c.payload?.platforms?.[0]?.accountId).sort();
      assert.deepStrictEqual(accountIds, ['dossie-fb-acct', 'dossie-ig-acct', 'dossie-tt-acct'],
        `got: ${JSON.stringify(accountIds)}`);
    });
    const fbCall = zernioCalls.find((c) => c.payload?.platforms?.[0]?.platform === 'facebook');
    check('dossie facebook call pinned dossie\'s own page_id', () => {
      assert.strictEqual(fbCall.payload.platforms[0].platformSpecificData?.pageId, 'dossie-fb-page',
        `got: ${JSON.stringify(fbCall.payload.platforms[0])}`);
    });
  }

  console.log('\nTest 4: heath-realtor row requesting an unconnected platform fails that platform only, never substitutes Dossie\'s account');
  {
    const { zernioCalls, jsonBody } = await runOnce({
      id: 'regr-realtor-video-0002',
      status: 'heath_approved',
      topic: 'boerne hill country',
      target_owner: 'heath-realtor',
      platforms: ['facebook', 'tiktok'], // tiktok has no heath-realtor row
      caption: 'More land, more drive time. Heath Shepard, REALTOR - Keller Williams City-View.',
      supabase_url: 'https://example.com/storage/v1/object/public/videos/regr-realtor2.mp4',
    });

    const calledPlatforms = zernioCalls.map((c) => c.payload?.platforms?.[0]?.platform);
    check('facebook still posted (via heath-realtor account)', () => {
      assert.ok(calledPlatforms.includes('facebook'), `calls: ${JSON.stringify(calledPlatforms)}`);
    });
    const tiktokCall = zernioCalls.find((c) => c.payload?.platforms?.[0]?.platform === 'tiktok');
    check('tiktok was never called (no heath-realtor zernio_accounts row for it)', () => {
      assert.ok(!tiktokCall, `tiktok Zernio call happened: ${JSON.stringify(tiktokCall)}`);
    });
    check('handler response reports the tiktok failure (row NOT silently marked posted)', () => {
      assert.strictEqual(jsonBody.ok, false, `expected ok:false because tiktok failed, got: ${JSON.stringify(jsonBody)}`);
    });
  }

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
