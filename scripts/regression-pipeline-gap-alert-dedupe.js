#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-11 URGENT fix to duplicate PIPELINE GAP
 * alerts in api/cron-send-for-approval.js.
 *
 * THE BUG
 * -------
 * Heath got three identical "PIPELINE GAP: approval cron found 0 draft
 * posts ready to send" Telegram alerts within one minute. The 0-draft-posts
 * condition stays true across repeated runs (manual triggers, possible
 * cron-job.org overlap) and the old code unconditionally sent a fresh
 * Telegram message every single run with no memory of "already told him".
 *
 * THE FIX
 * -------
 * Before sending, the cron now checks cron_notifications (same claim
 * pattern as api/cron-mission-watchdog.js's EOD digest dedupe) for a row
 * with notification_key='cron-send-for-approval-pipeline-gap' sent within
 * the last GAP_ALERT_COOLDOWN_MINUTES (360). Only the first alert in that
 * window actually reaches Telegram; every repeat run within the window is
 * silently skipped (still logged, still returns 200) until the cooldown
 * lapses.
 *
 * TEST (local mock PostgREST + intercepted Telegram send — ZERO production
 * access, ZERO real Telegram messages):
 *   Running the handler twice back-to-back with an empty draft queue both
 *   times sends exactly ONE Telegram gap alert, not two.
 *
 * Run manually:
 *   node scripts/regression-pipeline-gap-alert-dedupe.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');

function startMockSupabase() {
  const claimedKeys = new Set();
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const table = url.pathname.split('/').pop();
      const q = url.search || '';
      requests.push({ method: req.method, table, query: q });

      if (req.method === 'GET' && table === 'cron_notifications') {
        const keyMatch = q.match(/notification_key=eq\.([^&]+)/);
        const key = keyMatch ? decodeURIComponent(keyMatch[1]) : null;
        const rows = key && claimedKeys.has(key) ? [{ id: 1 }] : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows));
        return;
      }

      if (req.method === 'POST' && table === 'cron_notifications') {
        let body = null;
        try { body = JSON.parse(raw); } catch { body = null; }
        if (body && body.notification_key) claimedKeys.add(body.notification_key);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[{}]');
        return;
      }

      if (req.method === 'GET' && table === 'social_posts') {
        // Always empty — this is what triggers the pipeline-gap branch.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }

      // cron_runs telemetry etc — always fine.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[{}]');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, requests });
    });
  });
}

async function run() {
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try {
      fn();
      console.log(`  PASS: ${name}`);
      pass++;
    } catch (err) {
      console.error(`  FAIL: ${name}\n    ${err.message}`);
      fail++;
    }
  }

  const mock = await startMockSupabase();

  const realFetch = globalThis.fetch;
  const telegramSends = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('api.telegram.org')) {
      telegramSends.push({ url, body: init && init.body });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, result: { message_id: 999 } }),
      };
    }
    return realFetch(input, init);
  };

  process.env.SUPABASE_URL = `http://127.0.0.1:${mock.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.ANTHROPIC_API_KEY = ''; // skip real scoring calls (none reached — 0 items)
  process.env.TELEGRAM_MARKETING_BOT_TOKEN = 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID = 'test-chat-id';
  // Allowed (not suppressed) so we're exercising the real gate logic on the
  // "sends are permitted" path, with Telegram itself intercepted above.
  process.env.TELEGRAM_CRON_NOTIFICATIONS = 'on';

  delete require.cache[require.resolve(path.join(REPO, 'api/_lib/telegram-gate.js'))];
  delete require.cache[require.resolve(path.join(REPO, 'api/cron-send-for-approval.js'))];
  const handler = require(path.join(REPO, 'api/cron-send-for-approval.js'));

  function makeRes() {
    let statusCode = null;
    let jsonBody = null;
    return {
      status(code) { statusCode = code; return this; },
      json(body) { jsonBody = body; return this; },
      get statusCode() { return statusCode; },
      get jsonBody() { return jsonBody; },
    };
  }

  const req = { headers: { 'x-vercel-cron': '1' } };

  console.log('\nRun 1: empty draft queue — should send ONE gap alert');
  const res1 = makeRes();
  await handler(req, res1);
  check('run 1 responded 200', () => assert.strictEqual(res1.statusCode, 200));
  check('run 1 sent exactly one Telegram gap alert', () => assert.strictEqual(telegramSends.length, 1, `expected 1 Telegram send, got ${telegramSends.length}`));

  console.log('\nRun 2 (immediately after): empty draft queue again — should NOT send a second gap alert');
  const res2 = makeRes();
  await handler(req, res2);
  check('run 2 responded 200', () => assert.strictEqual(res2.statusCode, 200));
  check('run 2 sent NO additional Telegram alert (still exactly 1 total)', () => assert.strictEqual(telegramSends.length, 1, `expected still 1 Telegram send total after run 2, got ${telegramSends.length}`));
  check('run 2 reports gapAlerted=false', () => assert.strictEqual(res2.jsonBody && res2.jsonBody.gapAlerted, false, `expected gapAlerted:false, got ${JSON.stringify(res2.jsonBody)}`));

  globalThis.fetch = realFetch;
  mock.server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Regression test crashed:', err);
  process.exit(1);
});
