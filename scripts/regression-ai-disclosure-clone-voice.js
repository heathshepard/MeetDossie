#!/usr/bin/env node
'use strict';

/**
 * Regression test for the AI-disclosure gate in api/cron-post-videos.js
 * (2026-09-16, fixed to read off content 2026-09-17 — Quinn QA follow-up on
 * 20260916d_rust_owner_wiring.sql / commit b26068e7).
 *
 * THE BUG THIS GUARDS AGAINST: the gate used to be
 * `owner === 'heath-realtor'` — a proxy on WHO posted the video, not a fact
 * about WHAT the video contains. Heath's cloned voice
 * (heath-voice-clone-usage-scope.md) is approved for realtor AND Rust
 * content, and Rust now posts through this exact pipeline
 * (target_owner='rust', see 20260916d_rust_owner_wiring.sql) — so an
 * owner-literal check could never flag a clone-voiced Rust video, even
 * though the same disclosure requirement applies to it. The fix reads
 * video_library.uses_cloned_voice directly — a property of the content,
 * set by the pipeline that actually knows which voice rendered the audio
 * (scripts/queue-finished-videos.py), not inferred from target_owner.
 *
 * This test proves the gate is now keyed on uses_cloned_voice, NOT owner:
 * a clone-voiced video from ANY owner (realtor, rust, or a hypothetical
 * future brand) gets the disclosure flags; a non-clone video from ANY
 * owner (including heath-realtor, e.g. a live on-camera selfie clip that
 * never touched ElevenLabs) does not.
 *   - YouTube: platformSpecificData.containsSyntheticMedia = true
 *     (YouTube Data API v3 status.containsSyntheticMedia)
 *   - TikTok:  platformSpecificData.tiktokSettings.video_made_with_ai = true
 *
 * Field names verified 2026-09-16 against docs.zernio.com (llms-full.txt)
 * and developers.google.com/youtube/v3/docs/videos.
 *
 * Local mock PostgREST + intercepted Zernio/Telegram — ZERO production
 * access, ZERO real posts. Pattern mirrors
 * scripts/regression-post-videos-target-owner-routing.js.
 *
 * Run manually:
 *   node scripts/regression-ai-disclosure-clone-voice.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');

function scheduleRows() {
  const rows = [];
  for (let dow = 0; dow < 7; dow++) {
    for (const platform of ['youtube', 'tiktok', 'facebook']) {
      rows.push({ platform, day_of_week: dow, time_slots: ['00:00:00'], timezone: 'America/Chicago', is_active: true, max_per_day: 10, max_per_slot: null });
    }
  }
  return rows;
}

// zernio_accounts fixture: all three owners connected on youtube + tiktok
// here (tiktok isn't really connected for heath-realtor, and neither
// youtube nor tiktok is really connected for rust, yet — per
// docs/PIPELINE.md / 20260916d_rust_owner_wiring.sql — connecting them in
// THIS fixture only is deliberate, so the test proves the disclosure-flag
// logic itself, independent of which platforms happen to be wired up
// today, and independent of owner).
const ZERNIO_ACCOUNTS_TABLE = [
  { platform: 'youtube', owner: 'dossie', zernio_account_id: 'dossie-yt-acct', page_id: null },
  { platform: 'tiktok', owner: 'dossie', zernio_account_id: 'dossie-tt-acct', page_id: null },
  { platform: 'youtube', owner: 'heath-realtor', zernio_account_id: 'realtor-yt-acct', page_id: null },
  { platform: 'tiktok', owner: 'heath-realtor', zernio_account_id: 'realtor-tt-acct', page_id: null },
  { platform: 'youtube', owner: 'rust', zernio_account_id: 'rust-yt-acct', page_id: null },
  { platform: 'tiktok', owner: 'rust', zernio_account_id: 'rust-tt-acct', page_id: null },
];

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
        const row = ZERNIO_ACCOUNTS_TABLE.find((r) => r.platform === platform && r.owner === owner);
        if (!row) return json([]);
        return json([{ zernio_account_id: row.zernio_account_id, page_id: row.page_id }]);
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
      zernioCalls.push({ payload });
      return new Response(JSON.stringify({ post: { _id: `zn-${zernioCalls.length}` } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return underlyingFetch(input, init);
  };

  const req = { headers: { 'x-vercel-cron': '1' }, query: {} };
  let jsonBody = null;
  const res = {
    status() { return this; },
    json(obj) { jsonBody = obj; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
  await handler(req, res);
  globalThis.fetch = underlyingFetch;
  server.close();

  return { jsonBody, zernioCalls };
}

(async () => {
  const failures = [];
  const check = (name, fn) => {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (err) { failures.push(name); console.error(`  FAIL  ${name}\n        ${err.message}`); }
  };

  const casesThatMustDisclose = [
    ['heath-realtor', 'regr-clone-voice-heath-realtor-0001', 'option period waive',
      'Waiving your option period isnt always a bad idea. Heath Shepard, REALTOR.', 'regr-realtor.mp4'],
    ['rust', 'regr-clone-voice-rust-0001', 'readiness check heath',
      'Heath walks you through your first readiness check.', 'regr-rust-heath.mp4'],
  ];
  for (const [owner, id, topic, caption, file] of casesThatMustDisclose) {
    console.log(`Test: uses_cloned_voice=true, owner=${owner} — youtube+tiktok carry the AI-disclosure flags`);
    const { zernioCalls } = await runOnce({
      id,
      status: 'heath_approved',
      topic,
      target_owner: owner,
      uses_cloned_voice: true,
      platforms: ['youtube', 'tiktok'],
      caption,
      supabase_url: `https://example.com/storage/v1/object/public/videos/${file}`,
      quality_status: 'passed',
    });

    const ytCall = zernioCalls.find((c) => c.payload?.platforms?.[0]?.platform === 'youtube');
    const ttCall = zernioCalls.find((c) => c.payload?.platforms?.[0]?.platform === 'tiktok');

    check(`${owner}: youtube call sets platformSpecificData.containsSyntheticMedia = true`, () => {
      assert.ok(ytCall, 'no youtube Zernio call made');
      assert.strictEqual(ytCall.payload.platforms[0].platformSpecificData?.containsSyntheticMedia, true,
        `got: ${JSON.stringify(ytCall.payload.platforms[0].platformSpecificData)}`);
    });
    check(`${owner}: youtube title is still set alongside the disclosure (no regression on the existing field)`, () => {
      assert.ok(ytCall.payload.platforms[0].platformSpecificData?.title, 'title missing');
    });
    check(`${owner}: tiktok call sets platformSpecificData.tiktokSettings.video_made_with_ai = true`, () => {
      assert.ok(ttCall, 'no tiktok Zernio call made');
      assert.strictEqual(ttCall.payload.platforms[0].platformSpecificData?.tiktokSettings?.video_made_with_ai, true,
        `got: ${JSON.stringify(ttCall.payload.platforms[0].platformSpecificData)}`);
    });
  }

  const casesThatMustNotDisclose = [
    ['dossie', 'regr-luna-voice-dossie-0001', 'tc went dark', 'A TC went dark on me mid-deal.', 'regr-dossie.mp4'],
    ['rust', 'regr-marcus-voice-rust-0001', 'readiness check marcus',
      'Marcus walks you through your first readiness check.', 'regr-rust-marcus.mp4'],
    // The exact bug this class of fix targets: heath-realtor no longer
    // means "always disclose" by itself — a real on-camera selfie clip
    // that never touched ElevenLabs must not falsely disclose either.
    ['heath-realtor', 'regr-live-selfie-realtor-0001', 'earnest money basics',
      'Heath Shepard, REALTOR, on earnest money.', 'regr-realtor-live.mp4'],
  ];
  for (const [owner, id, topic, caption, file] of casesThatMustNotDisclose) {
    console.log(`\nTest: uses_cloned_voice=false, owner=${owner} — youtube+tiktok NEVER carry either disclosure flag`);
    const { zernioCalls } = await runOnce({
      id,
      status: 'heath_approved',
      topic,
      target_owner: owner,
      uses_cloned_voice: false,
      platforms: ['youtube', 'tiktok'],
      caption,
      supabase_url: `https://example.com/storage/v1/object/public/videos/${file}`,
      quality_status: 'passed',
    });

    const ytCall = zernioCalls.find((c) => c.payload?.platforms?.[0]?.platform === 'youtube');
    const ttCall = zernioCalls.find((c) => c.payload?.platforms?.[0]?.platform === 'tiktok');

    check(`${owner}: youtube call has NO containsSyntheticMedia field`, () => {
      assert.ok(ytCall, 'no youtube Zernio call made');
      assert.strictEqual(ytCall.payload.platforms[0].platformSpecificData?.containsSyntheticMedia, undefined,
        `got: ${JSON.stringify(ytCall.payload.platforms[0].platformSpecificData)}`);
    });
    check(`${owner}: tiktok call has NO tiktokSettings.video_made_with_ai field`, () => {
      assert.ok(ttCall, 'no tiktok Zernio call made');
      assert.strictEqual(ttCall.payload.platforms[0].platformSpecificData?.tiktokSettings, undefined,
        `got: ${JSON.stringify(ttCall.payload.platforms[0].platformSpecificData)}`);
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
