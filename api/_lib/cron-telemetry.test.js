'use strict';

// api/_lib/cron-telemetry.test.js
//
// Regression for the 2026-09-17 incident: local runs (agent worktrees,
// `.env.local` test runs) have SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
// populated and were writing real rows into the production cron_runs
// table, producing 25 bogus 'error' rows in a 2.6s window and an hour of
// false-alarm investigation.
//
// recordCronRun() must now write ONLY when it detects a genuine Vercel
// execution (`process.env.VERCEL` — the same signal already used in
// api/cron-customer-view-digest.js, api/cron-dossie-full-diagnostic.js,
// api/cron-ridge-watchdog.js), regardless of whether Supabase creds are
// present. It must still write when VERCEL is set, even outside this
// process's original env (a real preview/prod invocation), so a real
// failure is never silently swallowed by an overzealous guard.
//
// Run: node --test api/_lib/cron-telemetry.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const TELEMETRY_PATH = require.resolve('./cron-telemetry.js');

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(saved)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

function freshTelemetryModule() {
  delete require.cache[TELEMETRY_PATH];
  return require(TELEMETRY_PATH);
}

test('isRealVercelExecution: false when VERCEL is unset (local / worktree run)', async () => {
  await withEnv({ VERCEL: undefined }, () => {
    const { isRealVercelExecution } = freshTelemetryModule();
    assert.equal(isRealVercelExecution(), false);
  });
});

test('isRealVercelExecution: true when VERCEL=1 (real Vercel invocation)', async () => {
  await withEnv({ VERCEL: '1' }, () => {
    const { isRealVercelExecution } = freshTelemetryModule();
    assert.equal(isRealVercelExecution(), true);
  });
});

test('recordCronRun: no-ops and does NOT hit the network when VERCEL is unset, even with full Supabase creds present (simulated local/worktree run)', async () => {
  await withEnv(
    {
      VERCEL: undefined,
      SUPABASE_URL: 'https://stub.supabase.test',
      SUPABASE_SERVICE_ROLE_KEY: 'stub-service-role-key',
    },
    async () => {
      const { recordCronRun } = freshTelemetryModule();

      let fetchCalled = false;
      const originalFetch = global.fetch;
      global.fetch = async (...args) => {
        fetchCalled = true;
        throw new Error('fetch should never be called for a local run');
      };

      try {
        await recordCronRun('fake-cron-local-test', 'error', { http_status: 500 });
      } finally {
        global.fetch = originalFetch;
      }

      assert.equal(fetchCalled, false, 'recordCronRun must not write to prod when VERCEL is unset');
    }
  );
});

test('recordCronRun: DOES write when VERCEL is set (simulated real Vercel execution) — guard cannot suppress a genuine failure', async () => {
  await withEnv(
    {
      VERCEL: '1',
      VERCEL_ENV: 'production',
      SUPABASE_URL: 'https://stub.supabase.test',
      SUPABASE_SERVICE_ROLE_KEY: 'stub-service-role-key',
    },
    async () => {
      const { recordCronRun } = freshTelemetryModule();

      let fetchCalled = false;
      let capturedUrl = null;
      let capturedBody = null;
      const originalFetch = global.fetch;
      global.fetch = async (url, opts) => {
        fetchCalled = true;
        capturedUrl = url;
        capturedBody = JSON.parse(opts.body);
        return new Response('', { status: 200 });
      };

      try {
        await recordCronRun('fake-cron-prod-test', 'error', { http_status: 500 });
      } finally {
        global.fetch = originalFetch;
      }

      assert.equal(fetchCalled, true, 'recordCronRun must still write on a real Vercel execution');
      assert.match(capturedUrl, /^https:\/\/stub\.supabase\.test\/rest\/v1\/cron_runs/);
      assert.equal(capturedBody.cron_name, 'fake-cron-prod-test');
      assert.equal(capturedBody.last_status, 'error');
      // Source stamped so a future stray write is identifiable at a glance.
      assert.equal(capturedBody.last_meta.source, 'production');
    }
  );
});

test('recordCronRun: still no-ops when VERCEL is set but Supabase creds are missing (existing behavior preserved)', async () => {
  await withEnv(
    {
      VERCEL: '1',
      SUPABASE_URL: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
    },
    async () => {
      const { recordCronRun } = freshTelemetryModule();

      let fetchCalled = false;
      const originalFetch = global.fetch;
      global.fetch = async () => {
        fetchCalled = true;
        return new Response('', { status: 200 });
      };

      try {
        await recordCronRun('fake-cron-no-creds', 'ok', {});
      } finally {
        global.fetch = originalFetch;
      }

      assert.equal(fetchCalled, false);
    }
  );
});
