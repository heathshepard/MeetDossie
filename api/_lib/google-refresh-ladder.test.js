'use strict';

// api/_lib/google-refresh-ladder.test.js
//
// Proves the self-heal ladder, not just that it compiles. THE case that
// matters most (Heath, 2026-09-28): "Prove the self-heal path works with a
// test where the newest row is dead and an older row is valid — that's the
// case that would have saved today" — see
// 'newest row dead, older row valid -> self-heals via the older row'.
//
// Real in-memory fetch mock, ZERO network access. Injectable sleepImpl so
// retry/backoff tests run instantly.
//
// Run: node --test api/_lib/google-refresh-ladder.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { refreshWithLadder, classifyTokenResponse } = require('./google-refresh-ladder.js');

// --- fixtures ----------------------------------------------------------

function jsonRes(status, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

const ENV = {
  account: 'heath.shepard@kw.com',
  supabaseUrl: 'https://fake.supabase.co',
  serviceKey: 'fake-service-key',
  clientId: 'fake-client-id',
  clientSecret: 'fake-client-secret',
};

function row(id, updatedAt, refreshToken) {
  return { id, updated_at: updatedAt, google_email: ENV.account, refresh_token: refreshToken, oauth_provider: 'google_gmail' };
}

/**
 * @param {object} opts
 * @param {Array} opts.rows - rows the initial GET returns
 * @param {Object<string, Array>} opts.googlePlan - refresh_token -> array of
 *   step descriptors, consumed in order (last one repeats once exhausted).
 *   Each step: { status, body } for a normal HTTP response, or { throwMsg }
 *   to simulate a network exception.
 * @param {boolean} [opts.failPatch] - make every PATCH (persist + prune) fail
 */
function makeFetch(opts) {
  const calls = { google: {}, patches: [] };
  const fetchImpl = async (url, init) => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const params = new URLSearchParams(init.body);
      const rt = params.get('refresh_token');
      // Never allow the client_secret to leak through even in this test
      // harness's own bookkeeping — mirrors the real constraint.
      assert.ok(!('client_secret' in calls), 'client_secret must never be captured/logged');
      const plan = (opts.googlePlan && opts.googlePlan[rt]) || [{ status: 200, body: { access_token: 'unspecified-token', expires_in: 3600 } }];
      const n = calls.google[rt] = (calls.google[rt] || 0);
      calls.google[rt] = n + 1;
      const step = plan[n] !== undefined ? plan[n] : plan[plan.length - 1];
      if (step.throwMsg) throw new Error(step.throwMsg);
      return jsonRes(step.status, step.body);
    }
    // Supabase REST
    if (init && init.method === 'PATCH') {
      calls.patches.push({ url, body: JSON.parse(init.body) });
      if (opts.failPatch) return jsonRes(500, { message: 'boom' });
      return jsonRes(200, null);
    }
    // GET rows
    return jsonRes(200, opts.rows);
  };
  return { fetchImpl, calls };
}

const instantSleep = async () => {};

// --- classifyTokenResponse ----------------------------------------------

test('classifyTokenResponse: invalid_grant is permanent, distinct from other 4xx', () => {
  assert.equal(classifyTokenResponse(jsonResSync(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })).verdict, 'invalid_grant');
  assert.equal(classifyTokenResponse(jsonResSync(400, { error: 'invalid_client' })).verdict, 'client_config');
  assert.equal(classifyTokenResponse(jsonResSync(503, {})).verdict, 'transient');
  assert.equal(classifyTokenResponse(jsonResSync(200, { access_token: 'x', expires_in: 3600 })).verdict, 'success');
});
function jsonResSync(status, data) { return { ok: status >= 200 && status < 300, status, data }; }

// --- THE case that would have saved 2026-09-28 --------------------------

test('THE FIX: newest row dead (invalid_grant), older row valid -> self-heals via the older row', async () => {
  const rows = [
    row('newest', '2026-09-26T00:00:00Z', 'rt-dead-newest'),
    row('older', '2026-09-19T00:00:00Z', 'rt-alive-older'),
  ];
  const { fetchImpl, calls } = makeFetch({
    rows,
    googlePlan: {
      'rt-dead-newest': [{ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }],
      'rt-alive-older': [{ status: 200, body: { access_token: 'new-access-token', expires_in: 3600, scope: 'gmail.readonly' } }],
    },
  });

  const result = await refreshWithLadder({ ...ENV, fetchImpl, sleepImpl: instantSleep });

  assert.equal(result.outcome, 'healthy');
  assert.equal(result.winningRowId, 'older');
  assert.deepEqual(result.prunedIds, ['newest']);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].verdict, 'invalid_grant');
  assert.equal(result.attempts[1].verdict, 'success');

  // The newest (dead) row got refresh_token nulled; the older (winning) row
  // got access_token/expires_at persisted. Confirm from the actual PATCH
  // calls, and confirm no credential material leaked into the result.
  const prunePatch = calls.patches.find((p) => p.url.includes('newest'));
  assert.equal(prunePatch.body.refresh_token, null);
  const persistPatch = calls.patches.find((p) => p.url.includes('older'));
  assert.equal(persistPatch.body.access_token, 'new-access-token');

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('rt-dead-newest'), 'dead refresh token must never appear in the result');
  assert.ok(!serialized.includes('rt-alive-older'), 'live refresh token must never appear in the result');
  assert.ok(!serialized.includes('new-access-token'), 'access token must never appear in the result');
  assert.ok(!serialized.includes(ENV.clientSecret), 'client secret must never appear in the result');
});

// --- all rows genuinely dead ---------------------------------------------

test('all_revoked: every stored credential confirmed invalid_grant -> prunes all, reports the count', async () => {
  const rows = [
    row('r1', '2026-09-26T00:00:00Z', 'rt-1'),
    row('r2', '2026-09-19T00:00:00Z', 'rt-2'),
    row('r3', '2026-09-12T00:00:00Z', 'rt-3'),
  ];
  const invalidGrant = { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
  const { fetchImpl, calls } = makeFetch({
    rows,
    googlePlan: { 'rt-1': [invalidGrant], 'rt-2': [invalidGrant], 'rt-3': [invalidGrant] },
  });

  const result = await refreshWithLadder({ ...ENV, fetchImpl, sleepImpl: instantSleep });

  assert.equal(result.outcome, 'all_revoked');
  assert.equal(result.totalRows, 3);
  assert.deepEqual(result.prunedIds.sort(), ['r1', 'r2', 'r3']);
  assert.equal(calls.patches.length, 1, 'one batched prune PATCH, not one per row');
});

// --- transient failures get retried, not treated as dead -----------------

test('transient failure retries with backoff on the SAME row, then succeeds — never counted as invalid_grant', async () => {
  const rows = [row('r1', '2026-09-26T00:00:00Z', 'rt-1')];
  const { fetchImpl } = makeFetch({
    rows,
    googlePlan: {
      'rt-1': [
        { status: 503, body: { error: 'temporarily_unavailable' } },
        { throwMsg: 'ECONNRESET' },
        { status: 200, body: { access_token: 'recovered-token', expires_in: 3600 } },
      ],
    },
  });

  let sleeps = 0;
  const result = await refreshWithLadder({ ...ENV, fetchImpl, sleepImpl: async () => { sleeps += 1; } });

  assert.equal(result.outcome, 'healthy');
  assert.equal(result.attempts[0].verdict, 'success');
  assert.equal(result.attempts[0].tries, 3);
  assert.equal(result.prunedIds.length, 0, 'a transient hiccup must never prune a live row');
  assert.equal(sleeps, 2, 'backed off between the 2 failed attempts');
});

test('transient failure exhausts retries on row 1, ladder moves on and succeeds on row 2 without pruning row 1', async () => {
  const rows = [
    row('r1', '2026-09-26T00:00:00Z', 'rt-1'),
    row('r2', '2026-09-19T00:00:00Z', 'rt-2'),
  ];
  const { fetchImpl } = makeFetch({
    rows,
    googlePlan: {
      'rt-1': [{ status: 500, body: {} }], // repeats for every attempt -> exhausts retries, still transient
      'rt-2': [{ status: 200, body: { access_token: 'row2-token', expires_in: 3600 } }],
    },
  });

  const result = await refreshWithLadder({ ...ENV, fetchImpl, sleepImpl: instantSleep });

  assert.equal(result.outcome, 'healthy');
  assert.equal(result.winningRowId, 'r2');
  assert.equal(result.attempts[0].verdict, 'transient');
  assert.equal(result.attempts[0].tries, 3, 'retried the max before giving up on this row');
  assert.deepEqual(result.prunedIds, [], 'row 1 was never confirmed dead — must not be pruned on a guess');
});

// --- client credentials themselves are broken -----------------------------

test('client_config_error: bad client_id/secret stops the ladder immediately, does not burn every row', async () => {
  const rows = [
    row('r1', '2026-09-26T00:00:00Z', 'rt-1'),
    row('r2', '2026-09-19T00:00:00Z', 'rt-2'),
  ];
  const { fetchImpl, calls } = makeFetch({
    rows,
    googlePlan: { 'rt-1': [{ status: 401, body: { error: 'invalid_client', error_description: 'Unauthorized' } }] },
  });

  const result = await refreshWithLadder({ ...ENV, fetchImpl, sleepImpl: instantSleep });

  assert.equal(result.outcome, 'client_config_error');
  assert.equal(result.errorCode, 'invalid_client');
  assert.equal(calls.google['rt-1'], 1, 'only tried once — retrying a client-config error is pointless');
  assert.equal(calls.google['rt-2'], undefined, 'never touched row 2 — a different row cannot fix a bad client secret');
  assert.deepEqual(result.prunedIds, [], 'nothing here is a revoked GRANT — nothing gets pruned');
});

// --- the "alarm itself must not fail silently" class ----------------------

test('no_rows: no user_integrations row at all for the account', async () => {
  const { fetchImpl } = makeFetch({ rows: [] });
  const result = await refreshWithLadder({ ...ENV, fetchImpl, sleepImpl: instantSleep });
  assert.equal(result.outcome, 'no_rows');
});

test('misconfigured: a missing env var is reported distinctly from a dead token', async () => {
  const result = await refreshWithLadder({ ...ENV, clientSecret: '', fetchImpl: async () => { throw new Error('must not be called'); }, sleepImpl: instantSleep });
  assert.equal(result.outcome, 'misconfigured');
  assert.deepEqual(result.missingEnv, ['GOOGLE_CLIENT_SECRET']);
});

test('query_failed: Supabase itself is unreachable — distinct from invalid_grant', async () => {
  const fetchImpl = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  const result = await refreshWithLadder({ ...ENV, fetchImpl, sleepImpl: instantSleep });
  assert.equal(result.outcome, 'query_failed');
  assert.match(result.error, /ENOTFOUND/);
});

test('a failed persist after a real successful refresh is reported, not swallowed as healthy', async () => {
  const rows = [row('r1', '2026-09-26T00:00:00Z', 'rt-1')];
  const { fetchImpl } = makeFetch({
    rows,
    googlePlan: { 'rt-1': [{ status: 200, body: { access_token: 'tok', expires_in: 3600 } }] },
    failPatch: true,
  });
  const result = await refreshWithLadder({ ...ENV, fetchImpl, sleepImpl: instantSleep });
  assert.equal(result.outcome, 'healthy_persist_failed');
  assert.equal(result.winningRowId, 'r1');
  assert.ok(result.persistError);
});

test('a failed prune never turns all_revoked into a thrown error — best-effort', async () => {
  const rows = [row('r1', '2026-09-26T00:00:00Z', 'rt-1')];
  const { fetchImpl } = makeFetch({
    rows,
    googlePlan: { 'rt-1': [{ status: 400, body: { error: 'invalid_grant' } }] },
    failPatch: true,
  });
  const result = await refreshWithLadder({ ...ENV, fetchImpl, sleepImpl: instantSleep });
  assert.equal(result.outcome, 'all_revoked');
  assert.deepEqual(result.prunedIds, [], 'prune failed, so nothing was actually pruned — reported honestly, not thrown');
});

test('inconclusive: nothing succeeded, but not every row was cleanly invalid_grant either', async () => {
  const rows = [
    row('r1', '2026-09-26T00:00:00Z', 'rt-1'),
    row('r2', '2026-09-19T00:00:00Z', 'rt-2'),
  ];
  const { fetchImpl } = makeFetch({
    rows,
    googlePlan: {
      'rt-1': [{ status: 400, body: { error: 'invalid_grant' } }],
      'rt-2': [{ status: 500, body: {} }], // transient, exhausts retries, never resolved
    },
  });
  const result = await refreshWithLadder({ ...ENV, fetchImpl, sleepImpl: instantSleep });
  assert.equal(result.outcome, 'inconclusive');
  assert.deepEqual(result.prunedIds, ['r1'], 'the one row that WAS confirmed dead still gets pruned even though the overall call is inconclusive');
});

// --- resolveClient mode: per-row client resolution (2026-09-29 fix) -------
//
// Proves THE bug this fix closes: heath.shepard@kw.com carries a
// google_calendar row (minted by the INTERNAL client) newer than its
// google_gmail rows (minted by the CUSTOMER client). Flat single-client
// mode sends every row through the same client and breaks the newest row
// with unauthorized_client. resolveClient mode must pick the right client
// per row AND must not let one row's client_config error stop a different
// row that uses a working client.

function providerRow(id, updatedAt, refreshToken, provider) {
  return { id, updated_at: updatedAt, google_email: ENV.account, refresh_token: refreshToken, oauth_provider: provider };
}

test('resolveClient mode: newest row (internal client) refreshes fine even though older rows use a different (dead) client', async () => {
  const rows = [
    providerRow('cal', '2026-09-28T00:00:00Z', 'rt-internal', 'google_calendar'),
    providerRow('gmail-old', '2026-09-19T00:00:00Z', 'rt-customer', 'google_gmail'),
  ];
  const seenClientIds = [];
  const fetchImpl = async (url, init) => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const params = new URLSearchParams(init.body);
      seenClientIds.push(params.get('client_id'));
      const rt = params.get('refresh_token');
      if (rt === 'rt-internal') return jsonRes(200, { access_token: 'internal-token', expires_in: 3600 });
      return jsonRes(400, { error: 'unauthorized_client' }); // would fire if wrong client used
    }
    if (init && init.method === 'PATCH') return jsonRes(200, null);
    return jsonRes(200, rows);
  };

  const resolveClient = (provider) => (provider === 'google_calendar'
    ? { label: 'internal', clientId: 'internal-id', clientSecret: 'internal-secret', missingEnvNames: [] }
    : { label: 'customer', clientId: 'customer-id', clientSecret: 'customer-secret', missingEnvNames: [] });

  const result = await refreshWithLadder({
    account: ENV.account, supabaseUrl: ENV.supabaseUrl, serviceKey: ENV.serviceKey,
    resolveClient, fetchImpl, sleepImpl: instantSleep,
  });

  assert.equal(result.outcome, 'healthy');
  assert.equal(result.winningRowId, 'cal');
  assert.deepEqual(seenClientIds, ['internal-id'], 'never even tried the customer client — newest row won on the first attempt');
});

test('resolveClient mode: one provider client not configured does not block a different row from succeeding', async () => {
  const rows = [
    providerRow('cal', '2026-09-28T00:00:00Z', 'rt-internal', 'google_calendar'),
    providerRow('gmail-old', '2026-09-19T00:00:00Z', 'rt-customer', 'google_gmail'),
  ];
  const fetchImpl = async (url, init) => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return jsonRes(200, { access_token: 'customer-token', expires_in: 3600 });
    }
    if (init && init.method === 'PATCH') return jsonRes(200, null);
    return jsonRes(200, rows);
  };

  // Internal client env vars missing entirely -- must not block the
  // customer-client row from being tried and succeeding.
  const resolveClient = (provider) => (provider === 'google_calendar'
    ? { label: 'internal', clientId: null, clientSecret: null, missingEnvNames: ['GOOGLE_INTERNAL_CLIENT_ID', 'GOOGLE_INTERNAL_CLIENT_SECRET'] }
    : { label: 'customer', clientId: 'customer-id', clientSecret: 'customer-secret', missingEnvNames: [] });

  const result = await refreshWithLadder({
    account: ENV.account, supabaseUrl: ENV.supabaseUrl, serviceKey: ENV.serviceKey,
    resolveClient, fetchImpl, sleepImpl: instantSleep,
  });

  assert.equal(result.outcome, 'healthy');
  assert.equal(result.winningRowId, 'gmail-old');
  assert.equal(result.attempts[0].verdict, 'client_config');
  assert.match(result.attempts[0].errorCode, /env_missing/);
  assert.equal(result.attempts[1].verdict, 'success');
});
