#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-30 owner-attribution fix to
 * api/cron-analytics-sync.js (video-routing-personal-accounts task).
 *
 * THE GAPS
 * --------
 * 1. ZERNIO_ACCOUNTS was 4 hardcoded Dossie-brand account IDs — Heath's
 *    personal accounts (owner='heath-realtor') and Rust's (owner='rust')
 *    were never scanned for engagement AT ALL, regardless of platform.
 * 2. post_analytics.social_post_id is a hard FK to social_posts only —
 *    video_library posts (Pipeline B, the pipeline the personal-account
 *    routing change runs through) could never land a row here, on ANY
 *    account.
 *
 * THE FIX
 * -------
 * ZERNIO_ACCOUNTS is now loaded live from zernio_accounts (is_active=true),
 * across every owner, with owner + account_handle carried onto every
 * post_analytics row. A Zernio analytics row that doesn't match a
 * social_posts row is now ALSO checked against video_library's
 * zernio_deliveries[].zernio_post_id and, if matched, upserted with
 * video_library_id set instead of social_post_id.
 *
 * TESTS (local mock PostgREST + intercepted Zernio — ZERO production
 * access, ZERO real network calls):
 *   1. loadZernioAccounts() reads the DB-driven list (not the frozen
 *      4-account fallback) and includes a heath-realtor row.
 *   2. A Zernio post matching a heath-realtor video_library row's
 *      zernio_post_id upserts with video_library_id set, social_post_id
 *      NULL, owner='heath-realtor', and the right account_handle.
 *   3. A Zernio post matching a dossie social_posts row still upserts with
 *      social_post_id set (unchanged path) AND now carries owner='dossie'.
 *   4. The video match never PATCHes social_posts (nothing to update there
 *      for a video post).
 *
 * Run manually:
 *   node scripts/regression-analytics-sync-owner-attribution.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');

const ZERNIO_ACCOUNTS_TABLE = [
  { platform: 'facebook', owner: 'dossie', zernio_account_id: 'dossie-fb-acct', account_handle: '@meetdossie' },
  { platform: 'facebook', owner: 'heath-realtor', zernio_account_id: 'realtor-fb-acct', account_handle: '@HeathShepardRealtor' },
];

function startMock({ socialRow, videoRow }) {
  const state = { postAnalyticsUpserts: [], socialPatches: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const table = url.pathname.replace('/rest/v1/', '');
      const q = url.search;
      const json = (body, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (req.method === 'GET' && table === 'zernio_accounts') {
        return json(ZERNIO_ACCOUNTS_TABLE);
      }
      if (req.method === 'GET' && table === 'social_posts' && q.includes('status=eq.posted')) {
        return json(socialRow ? [socialRow] : []);
      }
      if (req.method === 'GET' && table === 'social_posts') {
        return json([]); // A/B-test group loads etc.
      }
      if (req.method === 'GET' && table === 'video_library') {
        return json(videoRow ? [videoRow] : []);
      }
      if (req.method === 'GET' && table === 'post_analytics') {
        return json([]); // top-performer threshold computation
      }
      if (req.method === 'POST' && table === 'post_analytics') {
        let body = null;
        try { body = JSON.parse(raw); } catch { body = null; }
        state.postAnalyticsUpserts.push(body);
        return json({}, 201);
      }
      if (req.method === 'PATCH' && table === 'social_posts') {
        let body = null;
        try { body = JSON.parse(raw); } catch { body = null; }
        state.socialPatches.push({ query: q, body });
        return json({}, 200);
      }
      json([]);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state })));
}

async function run({ socialRow, videoRow, zernioPostsByAccount }) {
  const { server, state } = await startMock({ socialRow, videoRow });
  const port = server.address().port;

  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'regr-dummy-key';
  process.env.ZERNIO_API_KEY = 'regr-dummy-zernio-key';
  process.env.CRON_SECRET = 'regr-dummy-secret';
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_MARKETING_BOT_TOKEN;
  delete process.env.TELEGRAM_SAGE_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_CRON_NOTIFICATIONS;

  delete require.cache[require.resolve(path.join(REPO, 'api', 'cron-analytics-sync.js'))];
  const handler = require(path.join(REPO, 'api', 'cron-analytics-sync.js'));

  const underlyingFetch = globalThis.fetch;
  globalThis.fetch = async function interceptedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('zernio.com/api/v1/analytics')) {
      const accountId = new URL(url).searchParams.get('accountId');
      const posts = zernioPostsByAccount[accountId] || [];
      return new Response(JSON.stringify({ posts }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return underlyingFetch(input, init);
  };

  const req = { headers: { 'x-vercel-cron': '1' } };
  let statusCode = null; let jsonBody = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(obj) { jsonBody = obj; return this; },
  };
  await handler(req, res);
  globalThis.fetch = underlyingFetch;
  server.close();

  return { statusCode, jsonBody, state };
}

// --------------------------------------------------------------------- main
(async () => {
  const failures = [];
  const check = (name, fn) => {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (err) { failures.push(name); console.error(`  FAIL  ${name}\n        ${err.message}`); }
  };

  const socialRow = {
    id: 'sp-1', post_id: 'sp-1-postid', platform: 'facebook', zernio_post_id: 'zn-social-1',
    posted_at: new Date().toISOString(), zernio_account_id: 'dossie-fb-acct',
    persona: null, topic: 'cost math', hook: null, hook_type: null, cta_type: null, hook_variant: null,
  };
  const videoRow = {
    id: 'dossie-story-selfie-2026-09-30-heath',
    target_owner: 'heath-realtor',
    zernio_deliveries: [
      { platform: 'facebook', zernio_post_id: 'zn-video-1', status: 'confirmed' },
    ],
  };

  const zernioPostsByAccount = {
    'dossie-fb-acct': [{ postId: 'zn-social-1', publishedAt: new Date().toISOString(), likes: 3, comments: 1, shares: 0, views: 10 }],
    'realtor-fb-acct': [{ postId: 'zn-video-1', publishedAt: new Date().toISOString(), likes: 40, comments: 5, shares: 2, views: 900 }],
  };

  const { jsonBody, state } = await run({ socialRow, videoRow, zernioPostsByAccount });

  console.log('Handler response:', JSON.stringify(jsonBody));
  console.log('post_analytics upserts:', JSON.stringify(state.postAnalyticsUpserts));

  console.log('\nTest 1: both accounts scanned (dossie AND heath-realtor)');
  check('exactly 2 post_analytics upserts (one per matched account)', () => {
    assert.strictEqual(state.postAnalyticsUpserts.length, 2, `got ${state.postAnalyticsUpserts.length}: ${JSON.stringify(state.postAnalyticsUpserts)}`);
  });

  console.log('\nTest 2: video_library match — video_library_id set, owner=heath-realtor');
  const videoUpsert = state.postAnalyticsUpserts.find((u) => u.video_library_id);
  check('a row with video_library_id exists', () => {
    assert.ok(videoUpsert, `no video-attributed row found: ${JSON.stringify(state.postAnalyticsUpserts)}`);
  });
  check('video_library_id matches the video row', () => {
    assert.strictEqual(videoUpsert.video_library_id, videoRow.id);
  });
  check('social_post_id is absent/null on the video row (never both)', () => {
    assert.ok(!videoUpsert.social_post_id, `got: ${videoUpsert.social_post_id}`);
  });
  check('owner=heath-realtor on the video row', () => {
    assert.strictEqual(videoUpsert.owner, 'heath-realtor', `got: ${videoUpsert.owner}`);
  });
  check('account_handle=@HeathShepardRealtor on the video row', () => {
    assert.strictEqual(videoUpsert.account_handle, '@HeathShepardRealtor', `got: ${videoUpsert.account_handle}`);
  });
  check('metrics carried through on the video row (views=900)', () => {
    assert.strictEqual(videoUpsert.views, 900, `got: ${videoUpsert.views}`);
  });

  console.log('\nTest 3: social_posts match still works, now owner-tagged');
  const socialUpsert = state.postAnalyticsUpserts.find((u) => u.social_post_id);
  check('a row with social_post_id exists', () => {
    assert.ok(socialUpsert, `no social-attributed row found: ${JSON.stringify(state.postAnalyticsUpserts)}`);
  });
  check('social_post_id matches the social row', () => {
    assert.strictEqual(socialUpsert.social_post_id, socialRow.id);
  });
  check('video_library_id is absent/null on the social row', () => {
    assert.ok(!socialUpsert.video_library_id, `got: ${socialUpsert.video_library_id}`);
  });
  check('owner=dossie on the social row', () => {
    assert.strictEqual(socialUpsert.owner, 'dossie', `got: ${socialUpsert.owner}`);
  });
  check('account_handle=@meetdossie on the social row', () => {
    assert.strictEqual(socialUpsert.account_handle, '@meetdossie', `got: ${socialUpsert.account_handle}`);
  });

  console.log('\nTest 4: a video match never PATCHes social_posts');
  check('zero social_posts PATCHes reference the video post', () => {
    const offender = state.socialPatches.find((p) => p.query.includes(videoRow.id));
    assert.ok(!offender, `unexpected social_posts PATCH for a video row: ${JSON.stringify(offender)}`);
  });
  check('exactly one social_posts PATCH happened (the real social match\'s inline-column update)', () => {
    assert.strictEqual(state.socialPatches.length, 1, `got ${state.socialPatches.length}: ${JSON.stringify(state.socialPatches)}`);
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
