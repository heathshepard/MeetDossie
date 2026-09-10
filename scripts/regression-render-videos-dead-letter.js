#!/usr/bin/env node
'use strict';

/**
 * Regression test for the Bug 1 fix in api/cron-render-videos.js
 * (docs/POSTING-ENGINE-PLAN-2026-09-09.md; supabase/migrations/20260909_social_posts_video_dead_letter.sql).
 *
 * THE BUG
 * -------
 * Creatomate has returned 402 Insufficient credits since 2026-06-30. The
 * render cron pulled the OLDEST unrendered rows first with no attempt
 * tracking and no terminal failure state, so the same handful of oldest
 * rows retried forever (burning ElevenLabs credits every run) and every
 * newer post behind them was never even attempted. The cron also always
 * returned HTTP 200, so cron_runs recorded "ok" for 10 weeks straight.
 *
 * THE FIX BEING PINNED DOWN
 * -------------------------
 *   1. render_attempts increments on every failed attempt.
 *   2. At 3 failed attempts the row flips to the terminal 'video_failed'
 *      status (excluded from every future query) regardless of error type.
 *   3. A 402 specifically bails the REST of the run immediately — no more
 *      posts in the queue are attempted this pass, even if there are more.
 *   4. A 402 bail returns a non-2xx HTTP status so withTelemetry records a
 *      real failure in cron_runs instead of "ok".
 *
 * All against in-memory mocks — ZERO production access, no real Creatomate/
 * ElevenLabs/Telegram calls, no real Supabase.
 *
 * Run manually:
 *   node scripts/regression-render-videos-dead-letter.js
 */

const assert = require('assert');
const path = require('path');

process.env.SUPABASE_URL = 'http://mock-supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-not-real';
process.env.CREATOMATE_API_KEY = 'test-key-not-real';
process.env.ELEVENLABS_API_KEY = 'test-key-not-real';
process.env.CRON_SECRET = 'test-cron-secret';
delete process.env.TELEGRAM_BOT_TOKEN; // skip real Telegram sends

// ─── In-memory social_posts table + generic PostgREST-shaped mock ─────────

let posts = [];

function matchFilter(row, key, expr) {
  if (expr.startsWith('eq.')) return String(row[key]) === decodeURIComponent(expr.slice(3));
  if (expr === 'is.null') return row[key] === null || row[key] === undefined;
  if (expr.startsWith('in.(')) {
    const vals = expr.slice(4, -1).split(',').map(decodeURIComponent);
    return vals.includes(String(row[key]));
  }
  return true;
}

function queryPosts(qs) {
  const q = {};
  for (const [k, v] of new URLSearchParams(qs || '')) q[k] = v;
  const filters = Object.entries(q).filter(([k]) => !['select', 'order', 'limit'].includes(k));
  let matched = posts.filter((r) => filters.every(([k, v]) => matchFilter(r, k, v)));
  if (q.order) {
    const [col, dir] = q.order.split('.');
    matched = [...matched].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (dir === 'desc' ? -1 : 1));
  }
  if (q.limit) matched = matched.slice(0, parseInt(q.limit, 10));
  return matched;
}

const patchCalls = []; // { id, body }
let creatomateCallCount = 0;
let creatomateBehavior = '402'; // '402' | 'ok'

function resetMocks({ seedPosts, behavior = '402' }) {
  posts = seedPosts.map((p) => ({ ...p }));
  patchCalls.length = 0;
  creatomateCallCount = 0;
  creatomateBehavior = behavior;
}

global.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = (init.method || 'GET').toUpperCase();

  // Supabase social_posts REST
  if (u.startsWith(`${process.env.SUPABASE_URL}/rest/v1/social_posts`)) {
    const qs = u.split('?')[1];
    if (method === 'GET') {
      return { ok: true, status: 200, text: async () => JSON.stringify(queryPosts(qs)) };
    }
    if (method === 'PATCH') {
      const q = {};
      for (const [k, v] of new URLSearchParams(qs || '')) q[k] = v;
      const idExpr = q.id || '';
      const id = idExpr.startsWith('eq.') ? decodeURIComponent(idExpr.slice(3)) : null;
      const body = JSON.parse(init.body);
      patchCalls.push({ id, body });
      const row = posts.find((p) => p.id === id);
      if (row) Object.assign(row, body);
      return { ok: true, status: 204, text: async () => '' };
    }
  }

  // Supabase storage — frame check (force "not found" so it falls back to
  // the public screen-recording URL) and voiceover upload (always ok).
  if (u.includes('/storage/v1/object/info/')) {
    return { ok: false, status: 404, text: async () => '' };
  }
  if (u.includes('/storage/v1/object/voiceovers/')) {
    // Test hook: a post_id containing "FAIL" simulates a non-Creatomate,
    // non-402 failure (e.g. a storage outage) so we can pin dead-lettering
    // for error types OTHER than 402 without touching Creatomate at all.
    if (u.includes('FAIL-voiceover')) {
      return { ok: false, status: 500, text: async () => 'storage unavailable' };
    }
    return { ok: true, status: 200, text: async () => '' };
  }
  if (u.includes('/storage/v1/object/social-cards/')) {
    return { ok: true, status: 200, text: async () => '' };
  }

  // Cron telemetry (non-fatal either way, but mock cleanly)
  if (u.includes('/rest/v1/cron_runs')) {
    return { ok: true, status: 200, text: async () => '[]' };
  }

  // ElevenLabs TTS
  if (u.startsWith('https://api.elevenlabs.io/')) {
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
  }

  // Creatomate render create
  if (u === 'https://api.creatomate.com/v1/renders') {
    creatomateCallCount++;
    if (creatomateBehavior === '402') {
      return {
        ok: false,
        status: 402,
        text: async () => JSON.stringify({ hint: 'Insufficient credits. Please check your subscription usage.' }),
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 'render-1' }]) };
  }
  if (u.startsWith('https://api.creatomate.com/v1/renders/')) {
    return { ok: true, status: 200, json: async () => ({ status: 'succeeded', url: 'https://example.com/video.mp4' }) };
  }

  // Telegram (should not fire — TELEGRAM_BOT_TOKEN unset — but stay safe)
  if (u.includes('api.telegram.org')) {
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }

  throw new Error(`Unmocked fetch in regression test: ${method} ${u}`);
};

function fakeReqRes() {
  const req = { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } };
  let statusCode = 200;
  const res = {
    status(code) { statusCode = code; this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    get statusCode() { return statusCode; },
    set statusCode(v) { statusCode = v; },
  };
  return { req, res };
}

function basePost(over = {}) {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    post_id: 'p-1',
    platform: 'tiktok',
    persona: 'dossie',
    topic: 'trec_education',
    content: 'Some caption text.',
    voiceover_script: 'Some voiceover text.',
    status: 'pending_video',
    video_required: true,
    media_url: null,
    approved_at: null,
    render_attempts: 0,
    created_at: '2026-06-30T11:00:10.000Z',
    ...over,
  };
}

// Freshly require the handler for each phase so no module-level state leaks
// (withTelemetry wraps but holds no cross-call state relevant here).
function loadHandler() {
  delete require.cache[require.resolve(path.join(__dirname, '..', 'api', 'cron-render-videos.js'))];
  delete require.cache[require.resolve(path.join(__dirname, '..', 'api', '_lib', 'cron-telemetry.js'))];
  return require(path.join(__dirname, '..', 'api', 'cron-render-videos.js'));
}

async function main() {
  // ── 1. First 402: attempt increments to 1, no dead-letter yet, response
  //    is a non-2xx failure, and the loop bails before touching row 2 ──────
  resetMocks({
    seedPosts: [
      basePost({ id: 'row-oldest', render_attempts: 0, created_at: '2026-06-30T11:00:10.000Z' }),
      basePost({ id: 'row-newer', render_attempts: 0, created_at: '2026-09-09T11:00:00.000Z' }),
    ],
    behavior: '402',
  });
  let handler = loadHandler();
  let { req, res } = fakeReqRes();
  await handler(req, res);

  assert.strictEqual(creatomateCallCount, 1, '402 bail: Creatomate called exactly once, not once per queued row');
  assert.strictEqual(patchCalls.length, 1, 'exactly one PATCH — only the row that actually hit Creatomate');
  assert.strictEqual(patchCalls[0].id, 'row-oldest', 'the oldest row is the one attempted (FIFO order preserved)');
  assert.strictEqual(patchCalls[0].body.render_attempts, 1, 'render_attempts incremented to 1');
  assert.strictEqual(patchCalls[0].body.status, undefined, 'status untouched below the dead-letter threshold');
  assert.ok(/402/.test(patchCalls[0].body.error_message), 'error_message records the 402');
  assert.ok(res.statusCode >= 400, `402 bail must return non-2xx so telemetry records a real failure (got ${res.statusCode})`);
  assert.strictEqual(res.body.ok, false, 'response body ok:false on a 402 bail');
  assert.strictEqual(res.body.error, 'creatomate_402_insufficient_credits', 'response names the real cause');

  // ── 2. Third consecutive 402 on the same row: dead-letter engages ───────
  resetMocks({
    seedPosts: [basePost({ id: 'row-3rd-strike', render_attempts: 2 })],
    behavior: '402',
  });
  handler = loadHandler();
  ({ req, res } = fakeReqRes());
  await handler(req, res);

  assert.strictEqual(patchCalls.length, 1);
  assert.strictEqual(patchCalls[0].body.render_attempts, 3, 'attempt count reaches 3');
  assert.strictEqual(patchCalls[0].body.status, 'video_failed', 'dead-letter status set at 3 attempts');

  // ── 3. Non-402 failure at attempt 3 ALSO dead-letters, but does NOT bail
  //    the rest of the queue (only a 402 stops the pass) ───────────────────
  resetMocks({
    seedPosts: [
      basePost({ id: 'row-other-failure', post_id: 'FAIL-voiceover-post', render_attempts: 2, platform: 'facebook' }),
      basePost({ id: 'row-should-still-run', post_id: 'ok-post', render_attempts: 0, created_at: '2026-09-09T11:00:01.000Z' }),
    ],
    behavior: 'ok', // Creatomate would succeed for the row that reaches it — the first row fails earlier (voiceover upload down), never touching Creatomate
  });
  handler = loadHandler();
  ({ req, res } = fakeReqRes());
  await handler(req, res);

  const firstPatch = patchCalls.find((c) => c.id === 'row-other-failure');
  assert.ok(firstPatch, 'first row failure recorded');
  assert.strictEqual(firstPatch.body.render_attempts, 3, 'non-402 failure still increments to the dead-letter threshold');
  assert.strictEqual(firstPatch.body.status, 'video_failed', 'non-402 failure dead-letters too, at 3 attempts');
  assert.strictEqual(patchCalls.length, 2, 'second row was still attempted — only a 402 bails the whole pass');
  const secondPatch = patchCalls.find((c) => c.id === 'row-should-still-run');
  assert.ok(secondPatch && secondPatch.body.media_url, 'second row rendered successfully (Creatomate returns ok in this phase)');
  assert.strictEqual(res.statusCode, 200, 'no 402 this run — normal 200 path (failed=1 but not an outage)');

  console.log('[regression-render-videos-dead-letter] ALL PASS');
}

main().catch((err) => {
  console.error('[regression-render-videos-dead-letter] FAILED:', err && err.stack || err);
  process.exit(1);
});
