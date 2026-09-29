'use strict';

// api/_lib/telegram-gate.test.js
//
// Coverage for the scheduled-Telegram kill switch, written 2026-09-17 while
// fixing backlog B3 (the daily regression suite's alerts were being eaten by
// this gate for two months and nobody could tell).
//
// The point of this file: TELEGRAM_CRON_NOTIFICATIONS is a Vercel *Sensitive*
// variable — its live value cannot be read back by anyone, agent or human.
// So "will the regression alert get through in production?" cannot be settled
// by inspecting config. It can only be settled by proving the answer is the
// same for EVERY possible value of that variable. That is what the matrix
// test below does.
//
// Run: node --test api/_lib/telegram-gate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const GATE_PATH = require.resolve('./telegram-gate');

// install() monkey-patches globalThis.fetch once per module instance, so any
// test that exercises interception needs a clean require.
function freshGate() {
  delete require.cache[GATE_PATH];
  return require('./telegram-gate');
}

function withEnv(value, fn) {
  const prev = process.env.TELEGRAM_CRON_NOTIFICATIONS;
  if (value === undefined) delete process.env.TELEGRAM_CRON_NOTIFICATIONS;
  else process.env.TELEGRAM_CRON_NOTIFICATIONS = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TELEGRAM_CRON_NOTIFICATIONS;
    else process.env.TELEGRAM_CRON_NOTIFICATIONS = prev;
  }
}

// ---------------------------------------------------------------------------
// The B3 fix itself.
// ---------------------------------------------------------------------------

test('cron-regression-suite is on the ALWAYS_ALLOW floor', () => {
  const { ALWAYS_ALLOW } = freshGate();
  assert.equal(
    ALWAYS_ALLOW.has('cron-regression-suite'),
    true,
    'B3: without this entry every regression alert is silently swallowed'
  );
});

test('regression alerts survive EVERY readable state of the Sensitive env var except strict', () => {
  const { isAllowed } = freshGate();

  // The full space of values parseMode() recognises, plus a couple of
  // realistic list values. TELEGRAM_CRON_NOTIFICATIONS cannot be read from
  // Vercel, so the only safe claim is one that holds across all of these.
  const everyMode = [
    undefined,            // unset — the documented default, "off by absence"
    '',
    'off', '0', 'false', 'no',
    'on', '1', 'true', 'all', 'yes',
    'alert-health',                          // list mode, not naming us
    'alert-health,cron-stripe-reconcile',    // list mode, not naming us
    'cron-regression-suite',                 // list mode, naming us
  ];

  for (const v of everyMode) {
    withEnv(v, () => {
      assert.equal(
        isAllowed('cron-regression-suite'),
        true,
        `expected allowed with TELEGRAM_CRON_NOTIFICATIONS=${JSON.stringify(v)}`
      );
    });
  }

  // 'strict' is the documented total-silence escape hatch and must still win.
  withEnv('strict', () => {
    assert.equal(isAllowed('cron-regression-suite'), false, "'strict' must still silence the floor");
  });
});

test('before the fix, the default env state would have blocked it (regression guard)', () => {
  const { isAllowed } = freshGate();
  // A job NOT on the floor is blocked when the var is unset. This is the
  // exact state cron-regression-suite was in from 2026-08-16 to 2026-09-17.
  withEnv(undefined, () => {
    assert.equal(isAllowed('cron-regression-suite-not-a-real-job'), false);
  });
});

// ---------------------------------------------------------------------------
// The interception behaviour the fix relies on.
// ---------------------------------------------------------------------------

test('install(): an allow-listed job reaches the real fetch', async () => {
  const gate = freshGate();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    await withEnv(undefined, async () => {
      const { muted } = gate.install('cron-regression-suite');
      assert.equal(muted, false);
      const res = await globalThis.fetch(
        'https://api.telegram.org/bot123:ABC/sendMessage',
        { method: 'POST', body: JSON.stringify({ chat_id: 1, text: 'hi' }) }
      );
      const body = await res.json();
      assert.equal(gate.wasSuppressed(body), false, 'a real send must not look suppressed');
      assert.equal(body.result.message_id, 42);
      assert.equal(calls.length, 1, 'the call must have reached the underlying fetch');
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('install(): a non-allow-listed job is suppressed, and says so in the body', async () => {
  const gate = freshGate();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response('{}', { status: 200 });
  };
  try {
    await withEnv(undefined, async () => {
      const { muted } = gate.install('cron-some-digest');
      assert.equal(muted, true);
      const res = await globalThis.fetch(
        'https://api.telegram.org/bot123:ABC/sendMessage',
        { method: 'POST', body: JSON.stringify({ chat_id: 1, text: 'hi' }) }
      );
      const body = await res.json();
      // The trap that hid the 2026-08-17 video_library incident: this looks
      // like success on res.ok and on body.ok.
      assert.equal(res.ok, true, 'suppressed sends deliberately still look 200/ok');
      assert.equal(body.ok, true);
      // ...and is only distinguishable via wasSuppressed().
      assert.equal(gate.wasSuppressed(body), true);
      assert.equal(body.delivered, false);
      assert.equal(calls.length, 0, 'nothing should have reached the network');
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('install(): read-only Bot API methods are never gated', async () => {
  const gate = freshGate();
  const original = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = async () => {
    hits += 1;
    return new Response('{"ok":true}', { status: 200 });
  };
  try {
    await withEnv(undefined, async () => {
      gate.install('cron-some-digest'); // muted job
      await globalThis.fetch('https://api.telegram.org/bot123:ABC/getMe');
      await globalThis.fetch('https://api.telegram.org/bot123:ABC/getUpdates');
      assert.equal(hits, 2, 'diagnostics must stay readable even when muted');
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('install(): non-Telegram traffic is untouched', async () => {
  const gate = freshGate();
  const original = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = async () => {
    hits += 1;
    return new Response('ok', { status: 200 });
  };
  try {
    await withEnv(undefined, async () => {
      gate.install('cron-some-digest');
      await globalThis.fetch('https://meetdossie.com/api/health');
      assert.equal(hits, 1);
    });
  } finally {
    globalThis.fetch = original;
  }
});
