#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-08-17 telegram-gate silent-suppression incident
 * (suppressed sends indistinguishable from delivery).
 *
 * THE FAILURE
 * -----------
 * api/_lib/telegram-gate.js (the TELEGRAM_CRON_NOTIFICATIONS kill switch,
 * installed 2026-08-16) short-circuits scheduled Telegram sends and returns a
 * fake success body ({ ok: true, result: { message_id: 0 } }). Callers that
 * check res.ok therefore believed the human was notified when nothing was
 * delivered. On 2026-08-17 api/cron-video-approval.js "sent" approval
 * messages for five finished videos, got the fake success, and marked all
 * five video_library rows pending_approval. Heath never saw the messages;
 * the videos sat unposted and invisible for three weeks (found 2026-09-07).
 *
 * THE FIX
 * -------
 *   - Gate fake payload now carries delivered:false + suppressed:true +
 *     suppressed_by:'telegram-gate', logged at WARN with a text preview.
 *   - Gate exports wasSuppressed(parsedBody) for callers to branch on.
 *   - Every caller that advances "the human was notified" state
 *     (pending_approval, *_sent_at, debounce/dedup stamps) skips or reverts
 *     that state when the send was suppressed.
 *
 * TESTS (local mock PostgREST — ZERO production access, ZERO real Telegram):
 *   1. Gate contract: with TELEGRAM_CRON_NOTIFICATIONS unset (suppress-all
 *      default), a sendMessage fetch resolves to a body with delivered===false
 *      and suppressed===true, and wasSuppressed() flags it — while a real
 *      Telegram success shape is NOT flagged.
 *   2. THE EXACT INCIDENT: cron-video-approval, given one 'ready'
 *      video_library row and a suppressed gate, must NOT leave the row in
 *      pending_approval — final status PATCHed for that row must be 'ready'
 *      and no telegram_message_id may be stamped.
 *
 * Run manually:
 *   node scripts/regression-telegram-gate-suppression-lies.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');
const VIDEO_ID = 'regr-video-0817-aaaa';

// ------------------------------------------------------------ mock PostgREST
// Just enough for cron-video-approval + fail-soft telemetry: serves the one
// 'ready' video, an empty skit_queue, and records every PATCH body in order.
const patches = []; // { table, query, body }

function startMockSupabase() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const url = new URL(req.url, 'http://localhost');
        const table = url.pathname.split('/').pop();

        if (req.method === 'PATCH') {
          let body = null;
          try { body = JSON.parse(raw); } catch { body = raw; }
          patches.push({ table, query: url.search, body });
          res.writeHead(204).end();
          return;
        }

        if (req.method === 'GET' && table === 'video_library') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([{
            id: VIDEO_ID,
            status: 'ready',
            type: 'feature-demo',
            topic: 'regression harness',
            platforms: ['facebook'],
            caption: 'regression test video',
            supabase_url: 'https://example.com/video.mp4',
          }]));
          return;
        }

        // skit_queue GET and anything else (telemetry upserts etc.): absorb.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ------------------------------------------------------------- fake req/res
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

  // Env BEFORE any require: suppress-all default, everything local.
  delete process.env.TELEGRAM_CRON_NOTIFICATIONS; // unset => gate suppresses
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'regr-dummy-key';
  process.env.TELEGRAM_BOT_TOKEN = 'regr-dummy-token';
  process.env.TELEGRAM_CHAT_ID = '111111';
  process.env.CRON_SECRET = 'regr-dummy-secret';

  // Requiring the handler installs the gate's fetch wrapper for this process.
  const handler = require(path.join(REPO, 'api', 'cron-video-approval.js'));
  const gate = require(path.join(REPO, 'api', '_lib', 'telegram-gate.js'));

  // ---- Test 1: gate contract --------------------------------------------
  console.log('\nTest 1: suppressed send is explicitly distinguishable from delivery');
  const tgRes = await fetch('https://api.telegram.org/botregr-dummy-token/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: '111111', text: 'gate contract probe' }),
  });
  const tgBody = await tgRes.json();

  check('suppressed body carries delivered:false', () => {
    assert.strictEqual(tgBody.delivered, false,
      `expected delivered:false on a suppressed send, got ${JSON.stringify(tgBody)}`);
  });
  check('suppressed body carries suppressed:true + suppressed_by', () => {
    assert.strictEqual(tgBody.suppressed, true);
    assert.strictEqual(tgBody.suppressed_by, 'telegram-gate');
  });
  check('wasSuppressed() is exported and flags the suppressed body', () => {
    assert.strictEqual(typeof gate.wasSuppressed, 'function',
      'telegram-gate must export wasSuppressed()');
    assert.strictEqual(gate.wasSuppressed(tgBody), true);
    assert.strictEqual(gate.wasSuppressed({ ok: tgBody, data: tgBody }), true,
      'wasSuppressed must also accept an {ok,data} wrapper');
  });
  check('wasSuppressed() does NOT flag a real Telegram success', () => {
    assert.strictEqual(
      gate.wasSuppressed({ ok: true, result: { message_id: 12345, date: 1 } }),
      false);
    assert.strictEqual(gate.wasSuppressed(null), false);
  });

  // ---- Test 2: the exact 2026-08-17 incident ----------------------------
  console.log('\nTest 2: cron-video-approval must not mark pending_approval on a suppressed send');
  patches.length = 0;
  const { req, res } = fakeReqRes();
  await handler(req, res);

  const videoPatches = patches.filter(
    (p) => p.table === 'video_library' && p.query.includes(encodeURIComponent(VIDEO_ID)),
  );
  const statuses = videoPatches.map((p) => p.body && p.body.status).filter(Boolean);
  const finalStatus = statuses.length ? statuses[statuses.length - 1] : null;

  check('handler completed with HTTP 200', () => {
    assert.strictEqual(res.result.statusCode, 200,
      `handler returned ${res.result.statusCode}: ${JSON.stringify(res.result.jsonBody)}`);
  });
  check('row does NOT end up pending_approval (incident condition)', () => {
    assert.notStrictEqual(finalStatus, 'pending_approval',
      `final PATCHed status for ${VIDEO_ID} is 'pending_approval' — the exact ` +
      `2026-08-17 bug: suppressed send treated as delivered. PATCH log: ${JSON.stringify(videoPatches)}`);
  });
  check("row is reverted to 'ready' so it stays retryable", () => {
    assert.strictEqual(finalStatus, 'ready',
      `expected final status 'ready', got ${JSON.stringify(statuses)}`);
  });
  check('no telegram_message_id stamped from the fake success', () => {
    const stamped = videoPatches.some((p) => p.body && p.body.telegram_message_id);
    assert.strictEqual(stamped, false,
      `telegram_message_id was stamped off a suppressed send: ${JSON.stringify(videoPatches)}`);
  });

  server.close();

  console.log('');
  if (failures.length) {
    console.error(`RESULT: FAIL (${failures.length} failing)`);
    process.exit(1);
  }
  console.log('RESULT: PASS — suppressed Telegram sends can no longer masquerade as deliveries');
  process.exit(0);
})().catch((err) => {
  console.error('RESULT: FAIL (harness crash)', err);
  process.exit(1);
});
