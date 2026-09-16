#!/usr/bin/env node
'use strict';

/**
 * Regression test for the local video quality gate's vision transport,
 * built 2026-09-16 to unblock unattended weekly video runs on a machine
 * without a usable ANTHROPIC_API_KEY (it's a write-only Vercel Sensitive
 * var, CLAUDE.md §19 — `vercel env pull` returns the literal string
 * "[SENSITIVE]", and Heath's .env.local carries that same literal string;
 * Bitwarden needs his master password to recover the real value).
 *
 * TWO THINGS UNDER TEST — everything here is mocked at the network boundary
 * (no real ANTHROPIC_API_KEY, no real network dependency, zero API cost).
 * The genuinely-real end-to-end proof against a live deployment (real
 * Anthropic call, real bad/good video frames) is a separate, deliberately
 * NOT-regression-suite run — see the session report for how that was done.
 *
 * A. api/verify-video-vision.js (the CRON_SECRET-gated Vercel route) —
 *    invoked directly as a real handler(req, res) call. Proves: auth gate,
 *    method gate, missing-key gate, payload validation (missing/oversized
 *    images, bad mimeType), and correct translation of every Anthropic-side
 *    failure mode (non-ok status incl. 413, unparseable body) into a
 *    non-200 response — never a silent pass.
 *
 * B. api/_lib/verify-video-quality.js's callVisionModel() proxy branch —
 *    taken when ANTHROPIC_API_KEY is the local placeholder "[SENSITIVE]"
 *    (ANTHROPIC_KEY_USABLE=false) and CRON_SECRET is set. Proves every
 *    transport failure (endpoint unreachable, 401, malformed { ok, result }
 *    shape, unparseable verdict, oversized outbound payload) throws and is
 *    caught by checkVideoQuality()'s per-rule try/catch as a FAILED rule —
 *    never a pass — and that a genuine success response is correctly wired
 *    into the verdict.
 *
 * Run manually:
 *   node scripts/regression-video-quality-vision-transport.js
 */

const assert = require('assert');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const REPO = path.join(__dirname, '..');
const ROUTE_PATH = path.join(REPO, 'api', 'verify-video-vision.js');
const PARSE_PATH = path.join(REPO, 'api', '_lib', 'vision-parse.js');
const GATE_PATH = path.join(REPO, 'api', '_lib', 'verify-video-quality.js');

const failures = [];
const check = (name, fn) => {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failures.push(name); console.error(`  FAIL  ${name}\n        ${err.message}`); }
};
const checkAsync = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failures.push(name); console.error(`  FAIL  ${name}\n        ${err.message}`); }
};

// ── fake Vercel req/res ──────────────────────────────────────────────────

function fakeReq({ headers = {}, method = 'POST', body = {} } = {}) {
  return { headers, method, body };
}
function fakeRes() {
  return {
    _status: 200,
    _json: null,
    _headers: {},
    status(code) { this._status = code; return this; },
    json(obj) { this._json = obj; return this; },
    setHeader(k, v) { this._headers[k] = v; },
  };
}

// Requires api/verify-video-vision.js fresh, with a specific env, without
// permanently mutating process.env for the rest of the run (top-level
// consts are captured at require-time, so this must re-require per env combo).
function freshRoute(envOverrides) {
  delete require.cache[require.resolve(ROUTE_PATH)];
  delete require.cache[require.resolve(PARSE_PATH)];
  const prev = { CRON_SECRET: process.env.CRON_SECRET, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  Object.assign(process.env, envOverrides);
  if (envOverrides.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  if (envOverrides.CRON_SECRET === undefined) delete process.env.CRON_SECRET;
  const mod = require(ROUTE_PATH);
  process.env.CRON_SECRET = prev.CRON_SECRET;
  process.env.ANTHROPIC_API_KEY = prev.ANTHROPIC_API_KEY;
  return mod;
}

// Requires api/_lib/verify-video-quality.js fresh, with a specific env
// (same reasoning as freshRoute).
function freshGate(envOverrides) {
  delete require.cache[require.resolve(GATE_PATH)];
  delete require.cache[require.resolve(PARSE_PATH)];
  const prev = { CRON_SECRET: process.env.CRON_SECRET, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  Object.assign(process.env, envOverrides);
  const mod = require(GATE_PATH);
  process.env.CRON_SECRET = prev.CRON_SECRET;
  process.env.ANTHROPIC_API_KEY = prev.ANTHROPIC_API_KEY;
  return mod;
}

function mockFetch(matchers) {
  const underlying = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async function mocked(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    calls.push({ url, init });
    for (const m of matchers) {
      if (url.includes(m.match)) return m.respond(url, init);
    }
    return underlying(input, init);
  };
  return { restore: () => { globalThis.fetch = underlying; }, calls };
}

const okAnthropicResponse = (obj) => new Response(
  JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(obj) }] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-quality-vision-transport-regr-'));

  // A real tiny PNG frame to feed compressFrameForVision() — a color-bar
  // testsrc still, cheap to generate, exercises the real ffmpeg compression
  // path (not a fake buffer).
  const framePng = path.join(tmpDir, 'frame.png');
  await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=1:duration=1', '-frames:v', '1', framePng]);

  // ══════════════════════════════════════════════════════════════════════
  // SECTION A — api/verify-video-vision.js route, direct handler(req,res)
  // ══════════════════════════════════════════════════════════════════════
  console.log('Section A: api/verify-video-vision.js route (direct handler calls)\n');

  await checkAsync('missing Authorization header -> 401, no images accepted', async () => {
    const { restore } = mockFetch([]);
    const mod = freshRoute({ CRON_SECRET: 'regr-cron-secret', ANTHROPIC_API_KEY: 'regr-anthropic-key' });
    const res = fakeRes();
    await mod(fakeReq({ headers: {}, body: { images: [], promptText: 'x' } }), res);
    restore();
    assert.strictEqual(res._status, 401);
    assert.strictEqual(res._json.ok, false);
  });

  await checkAsync('wrong bearer value -> 401', async () => {
    const mod = freshRoute({ CRON_SECRET: 'regr-cron-secret', ANTHROPIC_API_KEY: 'regr-anthropic-key' });
    const res = fakeRes();
    await mod(fakeReq({ headers: { authorization: 'Bearer wrong-value' } }), res);
    assert.strictEqual(res._status, 401);
  });

  await checkAsync('GET method -> 405', async () => {
    const mod = freshRoute({ CRON_SECRET: 'regr-cron-secret', ANTHROPIC_API_KEY: 'regr-anthropic-key' });
    const res = fakeRes();
    await mod(fakeReq({ headers: { authorization: 'Bearer regr-cron-secret' }, method: 'GET' }), res);
    assert.strictEqual(res._status, 405);
  });

  await checkAsync('ANTHROPIC_API_KEY unset on server -> 500, never fakes a pass', async () => {
    const mod = freshRoute({ CRON_SECRET: 'regr-cron-secret', ANTHROPIC_API_KEY: undefined });
    const res = fakeRes();
    await mod(fakeReq({ headers: { authorization: 'Bearer regr-cron-secret' }, body: { images: [{ base64: 'aa', mimeType: 'image/jpeg' }], promptText: 'x' } }), res);
    assert.strictEqual(res._status, 500);
    assert.strictEqual(res._json.ok, false);
  });

  await checkAsync('ANTHROPIC_API_KEY == literal "[SENSITIVE]" on server -> 500, same as unset', async () => {
    const mod = freshRoute({ CRON_SECRET: 'regr-cron-secret', ANTHROPIC_API_KEY: '[SENSITIVE]' });
    const res = fakeRes();
    await mod(fakeReq({ headers: { authorization: 'Bearer regr-cron-secret' }, body: { images: [{ base64: 'aa', mimeType: 'image/jpeg' }], promptText: 'x' } }), res);
    assert.strictEqual(res._status, 500);
  });

  await checkAsync('missing images array -> 400', async () => {
    const mod = freshRoute({ CRON_SECRET: 'regr-cron-secret', ANTHROPIC_API_KEY: 'regr-anthropic-key' });
    const res = fakeRes();
    await mod(fakeReq({ headers: { authorization: 'Bearer regr-cron-secret' }, body: { promptText: 'x' } }), res);
    assert.strictEqual(res._status, 400);
  });

  await checkAsync('bad mimeType -> 400', async () => {
    const mod = freshRoute({ CRON_SECRET: 'regr-cron-secret', ANTHROPIC_API_KEY: 'regr-anthropic-key' });
    const res = fakeRes();
    await mod(fakeReq({ headers: { authorization: 'Bearer regr-cron-secret' }, body: { images: [{ base64: 'aa', mimeType: 'image/gif' }], promptText: 'x' } }), res);
    assert.strictEqual(res._status, 400);
  });

  await checkAsync('oversized image base64 -> 400, refused before ever calling Anthropic', async () => {
    const { restore, calls } = mockFetch([{ match: 'api.anthropic.com', respond: () => { throw new Error('should never be called'); } }]);
    const mod = freshRoute({ CRON_SECRET: 'regr-cron-secret', ANTHROPIC_API_KEY: 'regr-anthropic-key' });
    const res = fakeRes();
    const huge = 'A'.repeat(2_000_001);
    await mod(fakeReq({ headers: { authorization: 'Bearer regr-cron-secret' }, body: { images: [{ base64: huge, mimeType: 'image/jpeg' }], promptText: 'x' } }), res);
    restore();
    assert.strictEqual(res._status, 400);
    assert.strictEqual(calls.filter((c) => c.url.includes('api.anthropic.com')).length, 0, 'must not reach Anthropic with an oversized image');
  });

  await checkAsync('Anthropic returns non-ok (529 overloaded) -> 502, fail-closed', async () => {
    const { restore } = mockFetch([{ match: 'api.anthropic.com', respond: () => new Response('overloaded', { status: 529 }) }]);
    const mod = freshRoute({ CRON_SECRET: 'regr-cron-secret', ANTHROPIC_API_KEY: 'regr-anthropic-key' });
    const res = fakeRes();
    await mod(fakeReq({ headers: { authorization: 'Bearer regr-cron-secret' }, body: { images: [{ base64: 'aa', mimeType: 'image/jpeg' }], promptText: 'x' } }), res);
    restore();
    assert.strictEqual(res._status, 502);
    assert.strictEqual(res._json.ok, false);
  });

  await checkAsync('Anthropic returns 413 (payload too large) -> 502, fail-closed same as any other non-ok', async () => {
    const { restore } = mockFetch([{ match: 'api.anthropic.com', respond: () => new Response('too large', { status: 413 }) }]);
    const mod = freshRoute({ CRON_SECRET: 'regr-cron-secret', ANTHROPIC_API_KEY: 'regr-anthropic-key' });
    const res = fakeRes();
    await mod(fakeReq({ headers: { authorization: 'Bearer regr-cron-secret' }, body: { images: [{ base64: 'aa', mimeType: 'image/jpeg' }], promptText: 'x' } }), res);
    restore();
    assert.strictEqual(res._status, 502);
  });

  await checkAsync('Anthropic returns ok but unparseable body (no JSON in text) -> 502, fail-closed', async () => {
    const { restore } = mockFetch([{ match: 'api.anthropic.com', respond: () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'sorry, I cannot help with that' }] }), { status: 200 }) }]);
    const mod = freshRoute({ CRON_SECRET: 'regr-cron-secret', ANTHROPIC_API_KEY: 'regr-anthropic-key' });
    const res = fakeRes();
    await mod(fakeReq({ headers: { authorization: 'Bearer regr-cron-secret' }, body: { images: [{ base64: 'aa', mimeType: 'image/jpeg' }], promptText: 'x' } }), res);
    restore();
    assert.strictEqual(res._status, 502);
  });

  await checkAsync('genuine success -> 200 { ok: true, result }', async () => {
    const { restore } = mockFetch([{ match: 'api.anthropic.com', respond: () => okAnthropicResponse({ hook_visible: true, text_seen: 'TEST HOOK', reason: 'mock' }) }]);
    const mod = freshRoute({ CRON_SECRET: 'regr-cron-secret', ANTHROPIC_API_KEY: 'regr-anthropic-key' });
    const res = fakeRes();
    await mod(fakeReq({ headers: { authorization: 'Bearer regr-cron-secret' }, body: { images: [{ base64: 'aa', mimeType: 'image/jpeg' }], promptText: 'x' } }), res);
    restore();
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._json.ok, true);
    assert.strictEqual(res._json.result.hook_visible, true);
  });

  // ══════════════════════════════════════════════════════════════════════
  // SECTION B — verify-video-quality.js proxy branch (caller side)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\nSection B: api/_lib/verify-video-quality.js proxy branch (caller side)\n');

  // ANTHROPIC_API_KEY == the real local placeholder, CRON_SECRET real ->
  // ANTHROPIC_KEY_USABLE=false, proxy branch taken.
  const localEnv = { ANTHROPIC_API_KEY: '[SENSITIVE]', CRON_SECRET: 'regr-cron-secret' };

  check('ANTHROPIC_KEY_USABLE is false for the literal local placeholder', () => {
    const gate = freshGate(localEnv);
    assert.strictEqual(gate.ANTHROPIC_KEY_USABLE, false);
  });

  await checkAsync('proxy endpoint unreachable (network error) -> callVisionModel throws, fail-closed', async () => {
    const gate = freshGate(localEnv);
    const { restore } = mockFetch([{ match: gate.VIDEO_QUALITY_VISION_URL, respond: () => { throw new Error('getaddrinfo ENOTFOUND'); } }]);
    let threw = false;
    try {
      await gate.callVisionModel([{ base64: 'aa', mimeType: 'image/jpeg' }], 'x');
    } catch (err) {
      threw = true;
    }
    restore();
    assert.strictEqual(threw, true);
  });

  await checkAsync('proxy returns 401 -> callVisionModel throws, fail-closed', async () => {
    const gate = freshGate(localEnv);
    const { restore } = mockFetch([{ match: gate.VIDEO_QUALITY_VISION_URL, respond: () => new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { status: 401 }) }]);
    let threw = false;
    try {
      await gate.callVisionModel([{ base64: 'aa', mimeType: 'image/jpeg' }], 'x');
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('401'), `expected 401 in error message, got: ${err.message}`);
    }
    restore();
    assert.strictEqual(threw, true);
  });

  await checkAsync('proxy returns malformed body (ok:true but no result) -> throws, fail-closed', async () => {
    const gate = freshGate(localEnv);
    const { restore } = mockFetch([{ match: gate.VIDEO_QUALITY_VISION_URL, respond: () => new Response(JSON.stringify({ ok: true }), { status: 200 }) }]);
    let threw = false;
    try {
      await gate.callVisionModel([{ base64: 'aa', mimeType: 'image/jpeg' }], 'x');
    } catch (err) { threw = true; }
    restore();
    assert.strictEqual(threw, true);
  });

  await checkAsync('proxy returns ok:false -> throws, fail-closed', async () => {
    const gate = freshGate(localEnv);
    const { restore } = mockFetch([{ match: gate.VIDEO_QUALITY_VISION_URL, respond: () => new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: 200 }) }]);
    let threw = false;
    try {
      await gate.callVisionModel([{ base64: 'aa', mimeType: 'image/jpeg' }], 'x');
    } catch (err) { threw = true; }
    restore();
    assert.strictEqual(threw, true);
  });

  await checkAsync('proxy returns non-JSON body -> throws, fail-closed (does not crash uncaught)', async () => {
    const gate = freshGate(localEnv);
    const { restore } = mockFetch([{ match: gate.VIDEO_QUALITY_VISION_URL, respond: () => new Response('<html>502 bad gateway</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }) }]);
    let threw = false;
    try {
      await gate.callVisionModel([{ base64: 'aa', mimeType: 'image/jpeg' }], 'x');
    } catch (err) { threw = true; }
    restore();
    assert.strictEqual(threw, true);
  });

  await checkAsync('proxy returns 413 -> throws, fail-closed', async () => {
    const gate = freshGate(localEnv);
    const { restore } = mockFetch([{ match: gate.VIDEO_QUALITY_VISION_URL, respond: () => new Response('too large', { status: 413 }) }]);
    let threw = false;
    try {
      await gate.callVisionModel([{ base64: 'aa', mimeType: 'image/jpeg' }], 'x');
    } catch (err) { threw = true; }
    restore();
    assert.strictEqual(threw, true);
  });

  await checkAsync('oversized outbound request refused BEFORE any fetch call (never risks a platform 413)', async () => {
    const gate = freshGate(localEnv);
    const { restore, calls } = mockFetch([{ match: gate.VIDEO_QUALITY_VISION_URL, respond: () => { throw new Error('should never be called'); } }]);
    const hugeImage = { base64: 'A'.repeat(gate.MAX_VISION_REQUEST_BYTES + 500_000), mimeType: 'image/jpeg' };
    let threw = false;
    let msg = '';
    try {
      await gate.callVisionModel([hugeImage], 'x');
    } catch (err) { threw = true; msg = err.message; }
    restore();
    assert.strictEqual(threw, true);
    assert.ok(msg.includes('too large'), `expected a "too large" error, got: ${msg}`);
    assert.strictEqual(calls.length, 0, 'must never attempt the network call for an oversized payload');
  });

  await checkAsync('genuine proxy success -> callVisionModel resolves with the parsed result', async () => {
    const gate = freshGate(localEnv);
    const { restore } = mockFetch([{
      match: gate.VIDEO_QUALITY_VISION_URL,
      respond: () => new Response(JSON.stringify({ ok: true, result: { hook_visible: true, text_seen: 'REAL PROXY PASS', reason: 'mock via proxy' } }), { status: 200 }),
    }]);
    const result = await gate.callVisionModel([{ base64: 'aa', mimeType: 'image/jpeg' }], 'x');
    restore();
    assert.strictEqual(result.hook_visible, true);
    assert.strictEqual(result.text_seen, 'REAL PROXY PASS');
  });

  await checkAsync('compressFrameForVision() produces a real compressed JPEG under budget from a real PNG frame', async () => {
    const gate = freshGate(localEnv);
    const img = await gate.compressFrameForVision(framePng);
    assert.strictEqual(img.mimeType, 'image/jpeg');
    assert.ok(img.base64.length > 0, 'expected non-empty base64');
    assert.ok(img.base64.length <= gate.MAX_VISION_FRAME_BASE64, `expected under budget, got ${img.base64.length}`);
  });

  await checkAsync('checkVideoQuality(): proxy failure holds ALL 4 vision rules on a real (synthetic) fixture, measurable rules unaffected', async () => {
    const gate = freshGate(localEnv);
    const goodVideo = path.join(tmpDir, 'good-fixture-b.mp4');
    await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=22', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '28', goodVideo]);
    const goodCover = path.join(tmpDir, 'good-fixture-b-cover.png');
    await execFileAsync('ffmpeg', ['-y', '-ss', '0', '-i', goodVideo, '-frames:v', '1', goodCover]);

    const { restore } = mockFetch([{ match: gate.VIDEO_QUALITY_VISION_URL, respond: () => new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { status: 401 }) }]);
    const result = await gate.checkVideoQuality({ videoPath: goodVideo, coverPath: goodCover });
    restore();

    assert.strictEqual(result.pass, false, 'overall must fail when every vision rule fails closed');
    for (const rule of ['hook_visible_frame0', 'hook_cleared_by_3s', 'opening_not_login_or_empty', 'captions_present']) {
      assert.strictEqual(result.rules[rule].pass, false, `${rule} must be held closed on a proxy failure`);
    }
    // The measurable rules ran on real ffmpeg output and are unaffected by
    // the vision-transport failure — proves the two rule families are
    // genuinely independent, not one masking the other.
    assert.strictEqual(result.rules.runtime_in_platform_range.pass, true, `measurable rule should be unaffected, detail: ${JSON.stringify(result.detail)}`);
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('');
  if (failures.length) {
    console.error(`RESULT: FAIL (${failures.length} failing: ${failures.join(', ')})`);
    process.exit(1);
  }
  console.log('RESULT: PASS');
  process.exit(0);
})().catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
