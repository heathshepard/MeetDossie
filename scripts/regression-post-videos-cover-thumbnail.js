#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-10-02 cover/thumbnail fix to
 * api/cron-post-videos.js.
 *
 * THE BUG
 * -------
 * video_library.cover_url has existed since
 * 20260915_video_library_quality_gate.sql. scripts/queue-finished-videos.py
 * rendered a cover, uploaded it to the public social-cards bucket, and wrote
 * the URL onto the row — and NOTHING EVER READ IT BACK. postToZernio() sent
 * `mediaItems: [{ url, type: 'video' }]` and nothing else, so every platform
 * fell back to deriving its own thumbnail from frame 0 of the mp4. On a
 * document explainer frame 0 is a page of TREC body text, so Heath's whole
 * Instagram grid rendered as identical unreadable grey tiles.
 *
 * The column was loaded into memory the whole time (the row is fetched with
 * no `select=`), which is what made this so easy to miss — nothing was
 * missing, nothing errored, the cover was just never passed on.
 *
 * THE FIX
 * -------
 * postToZernio() now takes opts.coverUrl and attaches it by each platform's
 * real mechanism (field names verified against docs.zernio.com 2026-10-02,
 * recorded in docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md §1.2a):
 *   mediaItems[].thumbnail                           -> facebook, youtube, linkedin
 *   platformSpecificData.instagramThumbnail          -> instagram
 *   tiktokSettings.video_cover_image_url             -> tiktok
 *
 * TESTS (local mock PostgREST + intercepted Zernio/Telegram — ZERO
 * production access, ZERO real posts):
 *   1. Facebook carries the cover on mediaItems[0].thumbnail.
 *   2. Instagram carries it on platformSpecificData.instagramThumbnail.
 *   3. TikTok carries it on tiktokSettings.video_cover_image_url.
 *   4. A row with NO cover_url still posts (never blocks the pipeline) and
 *      sends no thumbnail key at all — rather than the string "undefined",
 *      which Zernio would try to fetch as a URL.
 *   5. The AI-disclosure flag and the cover coexist on tiktokSettings — the
 *      cover must not clobber video_made_with_ai, which is a compliance
 *      field.
 *
 * Run manually:
 *   node scripts/regression-post-videos-cover-thumbnail.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');

const COVER = 'https://pgwoitbdiyubjugwufhk.supabase.co/storage/v1/object/public/social-cards/video-covers/regr-cover.png';

const ZERNIO_ACCOUNTS_TABLE = [
  { platform: 'facebook', owner: 'dossie', zernio_account_id: 'dossie-fb-acct', page_id: 'dossie-fb-page' },
  { platform: 'instagram', owner: 'dossie', zernio_account_id: 'dossie-ig-acct', page_id: null },
  { platform: 'tiktok', owner: 'dossie', zernio_account_id: 'dossie-tt-acct', page_id: null },
];

function scheduleRows() {
  const rows = [];
  for (let dow = 0; dow < 7; dow++) {
    for (const platform of ['facebook', 'instagram', 'tiktok']) {
      rows.push({
        platform, day_of_week: dow, time_slots: ['00:00:00'],
        timezone: 'America/Chicago', is_active: true, max_per_day: 10, max_per_slot: null,
      });
    }
  }
  return rows;
}

function startMockSupabase(videoRow) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const table = url.pathname.split('/').pop();
      const q = url.search || '';
      const json = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'PATCH') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[{}]'); return; }
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function runOnce(videoRow) {
  const server = await startMockSupabase(videoRow);
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
      zernioCalls.push({ payload, rawBody: init && init.body });
      return new Response(JSON.stringify({ post: { _id: `zn-${zernioCalls.length}` } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return underlyingFetch(input, init);
  };

  const req = { headers: { 'x-vercel-cron': '1' }, query: {} };
  const res = {
    status() { return this; }, json() { return this; },
    setHeader() { return this; }, end() { return this; },
  };
  await handler(req, res);
  globalThis.fetch = underlyingFetch;
  server.close();
  return { zernioCalls };
}

const baseRow = (over) => Object.assign({
  id: 'regr-cover-video-0001',
  status: 'heath_approved',
  topic: 'TREC 20-19 paragraph 5.B option period termination deadline',
  target_owner: 'dossie',
  platforms: ['facebook', 'instagram', 'tiktok'],
  caption: 'Paragraph 5.B is strict compliance. Comment OPTION and Dossie will send you every deadline.',
  supabase_url: 'https://example.com/storage/v1/object/public/videos/regr-cover.mp4',
  quality_status: 'passed',
}, over);

(async () => {
  const failures = [];
  const check = (name, fn) => {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (err) { failures.push(name); console.error(`  FAIL  ${name}\n        ${err.message}`); }
  };
  const byPlatform = (calls, p) => calls.find((c) => c.payload?.platforms?.[0]?.platform === p);

  console.log('Test 1-3: a cover_url on the row reaches every platform by its own mechanism');
  {
    const { zernioCalls } = await runOnce(baseRow({ cover_url: COVER }));
    const fb = byPlatform(zernioCalls, 'facebook');
    const ig = byPlatform(zernioCalls, 'instagram');
    const tt = byPlatform(zernioCalls, 'tiktok');

    check('facebook sends the cover on mediaItems[0].thumbnail', () => {
      assert.ok(fb, 'no facebook Zernio call made');
      assert.strictEqual(fb.payload.mediaItems[0].thumbnail, COVER,
        `got: ${JSON.stringify(fb.payload.mediaItems[0])}`);
    });
    check('instagram sends the cover on platformSpecificData.instagramThumbnail', () => {
      assert.ok(ig, 'no instagram Zernio call made');
      assert.strictEqual(ig.payload.platforms[0].platformSpecificData?.instagramThumbnail, COVER,
        `got: ${JSON.stringify(ig.payload.platforms[0].platformSpecificData)}`);
    });
    check('tiktok sends the cover on tiktokSettings.video_cover_image_url', () => {
      assert.ok(tt, 'no tiktok Zernio call made');
      const s = tt.payload.platforms[0].platformSpecificData?.tiktokSettings;
      assert.strictEqual(s?.video_cover_image_url, COVER, `got: ${JSON.stringify(s)}`);
    });
    check('the video itself is still the media item (cover did not replace it)', () => {
      assert.strictEqual(fb.payload.mediaItems[0].type, 'video');
      assert.ok(/regr-cover\.mp4$/.test(fb.payload.mediaItems[0].url),
        `got: ${fb.payload.mediaItems[0].url}`);
    });
  }

  console.log('\nTest 4: a row with NO cover_url still posts, and sends no thumbnail key');
  {
    const { zernioCalls } = await runOnce(baseRow({}));
    const fb = byPlatform(zernioCalls, 'facebook');
    const ig = byPlatform(zernioCalls, 'instagram');

    check('the post still goes out when there is no cover (never blocks the pipeline)', () => {
      assert.ok(fb, 'no facebook Zernio call made');
    });
    check('no thumbnail key is sent at all — not the string "undefined"', () => {
      assert.ok(!('thumbnail' in fb.payload.mediaItems[0]),
        `mediaItems[0] should have no thumbnail key, got: ${JSON.stringify(fb.payload.mediaItems[0])}`);
      assert.ok(!fb.rawBody.includes('undefined'), 'payload JSON contains the literal "undefined"');
    });
    check('instagram sends no instagramThumbnail when there is no cover', () => {
      assert.ok(!(ig.payload.platforms[0].platformSpecificData || {}).instagramThumbnail,
        `got: ${JSON.stringify(ig.payload.platforms[0].platformSpecificData)}`);
    });
  }

  console.log('\nTest 5: the cover must not clobber the AI-disclosure compliance flag');
  {
    const { zernioCalls } = await runOnce(baseRow({
      cover_url: COVER,
      uses_cloned_voice: true,
      target_owner: 'dossie',
    }));
    const tt = byPlatform(zernioCalls, 'tiktok');
    check('tiktokSettings carries BOTH video_cover_image_url and video_made_with_ai', () => {
      const s = tt.payload.platforms[0].platformSpecificData?.tiktokSettings;
      assert.strictEqual(s?.video_cover_image_url, COVER, `cover missing: ${JSON.stringify(s)}`);
      assert.strictEqual(s?.video_made_with_ai, true, `disclosure flag lost: ${JSON.stringify(s)}`);
    });
  }

  console.log(`\nRESULT: ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
