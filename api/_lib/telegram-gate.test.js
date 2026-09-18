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

// ---------------------------------------------------------------------------
// 2026-09-18 audit: 5 more interactive-approval jobs found muted by default,
// same class as the incident this file's fakeTelegramOk() names.
// ---------------------------------------------------------------------------

test('the 5 approval-plumbing jobs found muted in the 2026-09-18 audit are on the floor', () => {
  const { ALWAYS_ALLOW } = freshGate();
  for (const jobName of [
    'cron-video-approval',
    'cron-send-for-approval',
    'cron-send-engagement-approvals',
    'cron-cold-email-review',
    'cron-auto-approve',
  ]) {
    assert.equal(ALWAYS_ALLOW.has(jobName), true, `${jobName} must be on ALWAYS_ALLOW — silently muted approval plumbing is the exact incident class this file exists to prevent`);
  }
});

test('those 5 jobs actually deliver under the default (unset) env, not just listed', async () => {
  const gate = freshGate();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  };
  try {
    await withEnv(undefined, async () => {
      for (const jobName of ['cron-video-approval', 'cron-send-for-approval', 'cron-send-engagement-approvals', 'cron-cold-email-review', 'cron-auto-approve']) {
        calls.length = 0;
        await gate.runWithJobContext(jobName, async () => {
          const res = await globalThis.fetch('https://api.telegram.org/bot123:ABC/sendMessage', {
            method: 'POST',
            body: JSON.stringify({ chat_id: 1, text: 'approval card' }),
          });
          const body = await res.json();
          assert.equal(gate.wasSuppressed(body), false, `${jobName} must not be suppressed under default env`);
        });
        assert.equal(calls.length, 1, `${jobName} send must reach the network under default env`);
      }
    });
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// Suppression logging (Carter, 2026-09-18) — the observability half of the
// fix. A suppressed send used to leave a trace ONLY in console.warn; now it
// also writes a row to telegram_gate_suppressions for silence-alarm.js to
// query. Must never throw or block the caller, with or without a working
// Supabase endpoint.
// ---------------------------------------------------------------------------

test('a suppressed send logs a row to telegram_gate_suppressions when Supabase env is present', async () => {
  const gate = freshGate();
  const original = globalThis.fetch;
  const supabaseCalls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.telegram.org')) {
      throw new Error('must never reach the real Telegram API for a suppressed send');
    }
    if (String(url).includes('/rest/v1/telegram_gate_suppressions')) {
      supabaseCalls.push({ url: String(url), body: init && init.body });
      return new Response('[]', { status: 201 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  try {
    await withEnv(undefined, async () => {
      gate.install('cron-some-digest'); // muted job
      const res = await globalThis.fetch('https://api.telegram.org/bot123:ABC/sendMessage', {
        method: 'POST',
        body: JSON.stringify({ chat_id: 555, text: 'hello heath' }),
      });
      const body = await res.json();
      assert.equal(gate.wasSuppressed(body), true);
      assert.equal(supabaseCalls.length, 1, 'expected exactly one insert into telegram_gate_suppressions');
      const logged = JSON.parse(supabaseCalls[0].body);
      assert.equal(logged.job_name, 'cron-some-digest');
      assert.equal(logged.method, 'sendmessage');
      assert.equal(logged.chat_id, '555');
      assert.equal(logged.text_preview, 'hello heath');
    });
  } finally {
    globalThis.fetch = original;
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
});

test('a suppressed send never throws even when the Supabase insert fails', async () => {
  const gate = freshGate();
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.telegram.org')) {
      return new Response('should not be reached', { status: 200 });
    }
    throw new Error('simulated network failure writing the suppression log');
  };
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  try {
    await withEnv(undefined, async () => {
      gate.install('cron-some-digest');
      const res = await globalThis.fetch('https://api.telegram.org/bot123:ABC/sendMessage', {
        method: 'POST',
        body: JSON.stringify({ chat_id: 1, text: 'hi' }),
      });
      const body = await res.json();
      assert.equal(gate.wasSuppressed(body), true, 'the caller must still get a well-formed suppressed response');
    });
  } finally {
    globalThis.fetch = original;
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
});

test('a suppressed send does not attempt to log when Supabase env is absent', async () => {
  const gate = freshGate();
  const original = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = async (url) => {
    hits += 1;
    if (String(url).includes('api.telegram.org')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch to ${url} with no Supabase env configured`);
  };
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    await withEnv(undefined, async () => {
      gate.install('cron-some-digest');
      await globalThis.fetch('https://api.telegram.org/bot123:ABC/sendMessage', {
        method: 'POST',
        body: JSON.stringify({ chat_id: 1, text: 'hi' }),
      });
      // The send is suppressed before ever reaching the real fetch (our stub),
      // and recordSuppression() bails out immediately with no Supabase env —
      // so the underlying fetch is never called at all, for either purpose.
      assert.equal(hits, 0, 'no Supabase env configured -> no attempted network call of any kind');
    });
  } finally {
    globalThis.fetch = original;
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
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
