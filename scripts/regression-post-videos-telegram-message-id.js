#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-10-09 fix to sendForHeathReview() in
 * api/cron-post-videos.js.
 *
 * THE BUG
 * -------
 * sendForHeathReview() sent the per-video Telegram approval card via
 * sendTelegramMessage() but never persisted the returned message_id onto
 * video_library.telegram_message_id. api/_lib/outcome-causes.js and the
 * silence alarm treat a null telegram_message_id as "never sent to
 * Heath" — so a correctly-sent card looked like a silent failure.
 * cron-video-approval.js already captured and PATCHed this id correctly;
 * cron-post-videos.js did not.
 *
 * THE FIX
 * -------
 * sendForHeathReview() now captures sendTelegramMessage()'s return value,
 * reads result.message_id, and PATCHes it onto the video_library row
 * right after the send. A failed/suppressed send (no message_id) leaves
 * the column untouched (null).
 *
 * TESTS (local mock PostgREST + intercepted Telegram — ZERO production
 * access, ZERO real sends):
 *   1. A status='approved' video with quality_status='passed' sends a
 *      Telegram card and the handler PATCHes telegram_message_id with the
 *      id Telegram returned.
 *   2. The PATCH is scoped to that video's row (id=eq.<video.id>).
 *   3. If Telegram returns no message_id (send failure), no
 *      telegram_message_id PATCH happens.
 *
 * Run manually:
 *   node scripts/regression-post-videos-telegram-message-id.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');

function scheduleRows() {
  const rows = [];
  for (let dow = 0; dow < 7; dow++) {
    rows.push({ platform: 'facebook', day_of_week: dow, time_slots: ['00:00:00'], timezone: 'America/Chicago', is_active: true, max_per_day: 10, max_per_slot: null });
  }
  return rows;
}

const ZERNIO_ACCOUNTS_TABLE = [
  { platform: 'facebook', owner: 'dossie', zernio_account_id: 'dossie-fb-acct', page_id: 'dossie-fb-page' },
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
        if (q.includes('status=eq.approved')) return json([videoRow]);
        return json([]); // status=eq.heath_approved
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

async function runOnce(videoRow, { telegramMessageId }) {
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

  const telegramCalls = [];
  const underlyingFetch = globalThis.fetch;
  globalThis.fetch = async function interceptedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('api.telegram.org')) {
      let payload = null;
      try { payload = JSON.parse(init && init.body); } catch { payload = null; }
      telegramCalls.push({ payload });
      const body = telegramMessageId
        ? { ok: true, result: { message_id: telegramMessageId } }
        : { ok: false, description: 'regr: simulated send failure' };
      return new Response(JSON.stringify(body), {
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

  return { statusCode, jsonBody, telegramCalls, patches };
}

// --------------------------------------------------------------------- main
(async () => {
  const failures = [];
  const check = (name, fn) => {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (err) { failures.push(name); console.error(`  FAIL  ${name}\n        ${err.message}`); }
  };

  const videoRow = {
    id: 'regr-review-card-0001',
    status: 'approved',
    topic: 'tc went dark',
    target_owner: 'dossie',
    platforms: ['facebook'],
    caption: 'A TC went dark on me mid-deal.',
    supabase_url: 'https://example.com/storage/v1/object/public/videos/regr-review.mp4',
    quality_status: 'passed',
  };

  console.log('Test 1+2: successful send PATCHes telegram_message_id onto the right row');
  {
    const { patches } = await runOnce(videoRow, { telegramMessageId: 987654 });

    const messageIdPatch = patches.find(
      (p) => p.table === 'video_library' && p.body && Object.prototype.hasOwnProperty.call(p.body, 'telegram_message_id'),
    );

    check('a telegram_message_id PATCH happened', () => {
      assert.ok(messageIdPatch, `no telegram_message_id PATCH found; patches: ${JSON.stringify(patches)}`);
    });
    check('the PATCH carries the id Telegram returned', () => {
      assert.strictEqual(messageIdPatch.body.telegram_message_id, 987654,
        `got: ${JSON.stringify(messageIdPatch.body)}`);
    });
    check('the PATCH is scoped to this video\'s row', () => {
      assert.ok(messageIdPatch.query.includes(`id=eq.${videoRow.id}`),
        `query: ${messageIdPatch.query}`);
    });
  }

  console.log('\nTest 3: a failed send (no message_id) never PATCHes telegram_message_id');
  {
    const { patches } = await runOnce({ ...videoRow, id: 'regr-review-card-0002' }, { telegramMessageId: null });

    const messageIdPatch = patches.find(
      (p) => p.table === 'video_library' && p.body && Object.prototype.hasOwnProperty.call(p.body, 'telegram_message_id'),
    );
    check('no telegram_message_id PATCH happened on a failed send', () => {
      assert.ok(!messageIdPatch, `unexpected PATCH: ${JSON.stringify(messageIdPatch)}`);
    });
  }

  console.log('');
  if (failures.length) {
    console.error(`${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
})();
