#!/usr/bin/env node
'use strict';

/**
 * Regression test: support-ticket alerts must be audible through the
 * telegram-gate kill switch (ALWAYS_ALLOW membership).
 *
 * THE FAILURE
 * -----------
 * api/cron-support-ticket-alert.js exists so no customer ticket goes silent
 * for weeks (built after the Miki incident — 16 days unanswered, 2026-06-17).
 * But the TELEGRAM_CRON_NOTIFICATIONS kill switch (off by default since
 * 2026-08-16) suppressed its sends like any other cron's:
 *
 *   - Before 54f0b70c: the cron took the gate's fake success, stamped
 *     heath_alerted_at, and escalated stage after stage into the void.
 *     Live casualty: ticket 503a1d1b (Amanda Nuckles, founding member,
 *     "How do I cancel my account?", 2026-08-24) — heath_alert_count=4,
 *     stage '7d', Heath saw none of them.
 *   - After 54f0b70c: no stamp on suppressed sends — better, but the net
 *     behavior became "silently retry forever". Alerts still never landed.
 *
 * THE FIX
 * -------
 * 'cron-support-ticket-alert' (and 'cron-unsubscribe-spike-monitor') join
 * ALWAYS_ALLOW in api/_lib/telegram-gate.js: exception-only alerts that are
 * silent on a healthy system and page Heath only when something a customer
 * depends on is actually broken.
 *
 * TESTS (fetch fully mocked — ZERO production access, ZERO real Telegram):
 *   1. Gate policy: with TELEGRAM_CRON_NOTIFICATIONS unset (suppress-all
 *      default) isAllowed() is true for both new ALWAYS_ALLOW members,
 *      false for a routine digest (gate still does its job), and false
 *      for everything in 'strict' mode (the documented total-silence path).
 *   2. END TO END: cron-support-ticket-alert, given one open 3h-old ticket
 *      and the default (off) gate mode, must put a real sendMessage on the
 *      wire (our mock) and stamp heath_alerted_at stage 'first'. Pre-fix
 *      the gate eats the send: no wire call, no stamp, ticket silent.
 *
 * Run manually:
 *   node scripts/regression-support-ticket-alert-always-audible.js
 */

const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..');
const TICKET_ID = 'regr-ticket-0907-aaaa';

// ---------------------------------------------------------------- fetch mock
// Installed BEFORE the handler is required, so telegram-gate wraps THIS.
// Allowed Telegram sends land here; suppressed ones never reach it — that
// difference is exactly what test 2 asserts.
const telegramCalls = [];
const ticketPatches = [];

function jsonResponse(body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

globalThis.fetch = async function mockFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';

  if (url.includes('api.telegram.org')) {
    telegramCalls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    // Real Telegram success shape (NOT the gate's suppressed shape).
    return jsonResponse({ ok: true, result: { message_id: 777, date: Math.floor(Date.now() / 1000) } });
  }

  if (url.includes('/rest/v1/support_tickets')) {
    if ((init.method || 'GET').toUpperCase() === 'PATCH') {
      let body = null;
      try { body = JSON.parse(init.body); } catch { /* ignore */ }
      ticketPatches.push({ url, body });
      return new Response(null, { status: 204 });
    }
    if (url.includes('heath_alerted_at=not.is.null')) {
      // countEverAlerted(): pretend one historical alert exists so the cron
      // takes the NORMAL escalation path, not the first-run backfill path.
      return jsonResponse([{ id: 'regr-older-ticket' }], { 'content-range': '0-0/1' });
    }
    // fetchOpenTickets(): one open ticket, 3h old, never alerted.
    return jsonResponse([{
      id: TICKET_ID,
      agent_email: 'regr-customer@example.com',
      user_id: null,
      ticket_type: 'bug',
      message: 'regression harness ticket',
      created_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
      heath_alerted_at: null,
      heath_alert_count: 0,
      heath_last_escalation_stage: null,
    }]);
  }

  // profiles lookup, cron telemetry upserts, anything else: absorb.
  return jsonResponse([]);
};

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

  // Env BEFORE any require: suppress-all default, everything local/dummy.
  delete process.env.TELEGRAM_CRON_NOTIFICATIONS; // unset => gate 'off' mode
  delete process.env.SUPPORT_ALERT_DRY_RUN;
  delete process.env.SUPPORT_ALERT_TEST_MODE;
  process.env.SUPABASE_URL = 'http://127.0.0.1:1/regr-mocked'; // never dialed — fetch is mocked
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'regr-dummy-key';
  process.env.TELEGRAM_BOT_TOKEN = 'regr-dummy-token';
  process.env.TELEGRAM_CHAT_ID = '111111';
  process.env.CRON_SECRET = 'regr-dummy-secret';

  // Requiring the handler installs the gate's fetch wrapper over our mock.
  const handler = require(path.join(REPO, 'api', 'cron-support-ticket-alert.js'));
  const gate = require(path.join(REPO, 'api', '_lib', 'telegram-gate.js'));

  // ---- Test 1: gate policy ----------------------------------------------
  console.log('\nTest 1: ALWAYS_ALLOW policy for exception-only customer-facing alerts');
  check("isAllowed('cron-support-ticket-alert') with switch unset/off", () => {
    assert.strictEqual(gate.isAllowed('cron-support-ticket-alert'), true,
      'cron-support-ticket-alert must be in ALWAYS_ALLOW — an unanswered ' +
      'customer ticket must page Heath even with cron notifications off');
  });
  check("isAllowed('cron-unsubscribe-spike-monitor') with switch unset/off", () => {
    assert.strictEqual(gate.isAllowed('cron-unsubscribe-spike-monitor'), true,
      'cron-unsubscribe-spike-monitor must be in ALWAYS_ALLOW — a deliverability ' +
      'bleed threatens every transactional send');
  });
  check('routine digests are STILL suppressed (gate purpose intact)', () => {
    assert.strictEqual(gate.isAllowed('cron-morning-brief'), false);
    assert.strictEqual(gate.isAllowed('cron-video-approval'), false);
    assert.strictEqual(gate.isAllowed('cron-send-for-approval'), false);
  });
  check("'strict' mode silences even ALWAYS_ALLOW (documented escape hatch)", () => {
    process.env.TELEGRAM_CRON_NOTIFICATIONS = 'strict';
    try {
      assert.strictEqual(gate.isAllowed('cron-support-ticket-alert'), false);
    } finally {
      delete process.env.TELEGRAM_CRON_NOTIFICATIONS;
    }
  });

  // ---- Test 2: end to end — the alert actually goes out ------------------
  console.log('\nTest 2: open ticket produces a real send + heath_alerted_at stamp with gate off');
  telegramCalls.length = 0;
  ticketPatches.length = 0;
  const { req, res } = fakeReqRes();
  await handler(req, res);

  const sends = telegramCalls.filter((c) => c.url.includes('sendMessage'));
  const stampPatches = ticketPatches.filter(
    (p) => p.url.includes(encodeURIComponent(TICKET_ID)) && p.body && p.body.heath_alerted_at,
  );

  check('handler completed with HTTP 200', () => {
    assert.strictEqual(res.result.statusCode, 200,
      `handler returned ${res.result.statusCode}: ${JSON.stringify(res.result.jsonBody)}`);
  });
  check('a sendMessage actually reached the wire (not eaten by the gate)', () => {
    assert.strictEqual(sends.length, 1,
      `expected exactly 1 outbound sendMessage, saw ${sends.length} — a ` +
      'suppressed send never reaches the network, which is the pre-fix bug ' +
      '("silently retries forever", Heath never paged)');
  });
  check('alert mentions the ticket id', () => {
    assert.ok(sends[0] && String(sends[0].body && sends[0].body.text).includes(TICKET_ID),
      `alert text missing ticket id: ${JSON.stringify(sends[0] && sends[0].body)}`);
  });
  check("heath_alerted_at stamped with stage 'first' (delivery was real, so stamping is correct)", () => {
    assert.strictEqual(stampPatches.length, 1,
      `expected 1 stamp PATCH, saw ${stampPatches.length}: ${JSON.stringify(ticketPatches)}`);
    assert.strictEqual(stampPatches[0].body.heath_last_escalation_stage, 'first');
    assert.strictEqual(stampPatches[0].body.heath_alert_count, 1);
  });
  check('handler reports alerts_sent=1, telegram_suppressed=0', () => {
    const stats = res.result.jsonBody && res.result.jsonBody.stats;
    assert.ok(stats, `no stats in response: ${JSON.stringify(res.result.jsonBody)}`);
    assert.strictEqual(stats.alerts_sent, 1, `alerts_sent=${stats.alerts_sent}`);
    assert.ok(!stats.telegram_suppressed,
      `telegram_suppressed=${stats.telegram_suppressed} — gate ate the alert`);
  });

  console.log('');
  if (failures.length) {
    console.error(`RESULT: FAIL (${failures.length} failing)`);
    process.exit(1);
  }
  console.log('RESULT: PASS — support-ticket alerts are audible through the kill switch');
  process.exit(0);
})().catch((err) => {
  console.error('RESULT: FAIL (harness crash)', err);
  process.exit(1);
});
