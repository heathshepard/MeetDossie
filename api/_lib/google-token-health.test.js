'use strict';

// api/_lib/google-token-health.test.js
//
// Proves checkGoogleTokenHealth() -- the function api/_lib/silence-alarm.js
// actually calls in runAllChecks() -- maps every non-healthy ladder outcome
// to exactly one alert condition with a distinct `key` (so alert_state's
// per-key cooldown can never suppress a NEW failure type), that a healthy
// or self-healed run stays silent, and that no returned message ever
// contains credential material.
//
// Run: node --test api/_lib/google-token-health.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkGoogleTokenHealth, GOOGLE_ACCOUNT } = require('./google-token-health.js');

function jsonRes(status, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

const ENV = {
  supabaseUrl: 'https://fake.supabase.co',
  serviceKey: 'fake-service-key',
  clientId: 'fake-client-id',
  clientSecret: 'fake-super-secret-value',
};

function row(id, updatedAt, refreshToken) {
  return { id, updated_at: updatedAt, google_email: GOOGLE_ACCOUNT, refresh_token: refreshToken, oauth_provider: 'google_gmail' };
}

function makeFetch({ rows, googlePlan, failPatch }) {
  const calls = { google: {} };
  return async (url, init) => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const params = new URLSearchParams(init.body);
      const rt = params.get('refresh_token');
      const plan = (googlePlan && googlePlan[rt]) || [{ status: 200, body: { access_token: 'tok', expires_in: 3600 } }];
      const n = calls.google[rt] = (calls.google[rt] || 0);
      calls.google[rt] = n + 1;
      const step = plan[n] !== undefined ? plan[n] : plan[plan.length - 1];
      if (step.throwMsg) throw new Error(step.throwMsg);
      return jsonRes(step.status, step.body);
    }
    if (init && init.method === 'PATCH') return jsonRes(failPatch ? 500 : 200, failPatch ? { message: 'boom' } : null);
    return jsonRes(200, rows);
  };
}

const instantSleep = async () => {};

test('healthy: [] when the newest row still refreshes fine', async () => {
  const fetchImpl = makeFetch({ rows: [row('r1', '2026-09-28T00:00:00Z', 'rt-1')], googlePlan: {} });
  const conditions = await checkGoogleTokenHealth({ fetchImpl, sleepImpl: instantSleep, env: ENV });
  assert.deepEqual(conditions, []);
});

test('healthy: [] when the newest row is dead but the ladder self-heals via an older row (silent recovery)', async () => {
  const rows = [row('newest', '2026-09-26T00:00:00Z', 'rt-dead'), row('older', '2026-09-19T00:00:00Z', 'rt-alive')];
  const fetchImpl = makeFetch({
    rows,
    googlePlan: {
      'rt-dead': [{ status: 400, body: { error: 'invalid_grant' } }],
      'rt-alive': [{ status: 200, body: { access_token: 'tok', expires_in: 3600 } }],
    },
  });
  const conditions = await checkGoogleTokenHealth({ fetchImpl, sleepImpl: instantSleep, env: ENV });
  assert.deepEqual(conditions, [], 'self-heal must stay silent -- alerting is the last resort, not the deliverable');
});

// --- THE LIVE 2026-09-29 INCIDENT, reproduced at this file's own level ----
//
// heath.shepard@kw.com's real user_integrations has BOTH a 'google_calendar'
// row (INTERNAL client) and a 'google_gmail' row (CUSTOMER client). This
// check used to send every row through the single CUSTOMER pair, so the
// INTERNAL-issued row failed with unauthorized_client and aborted before
// ever trying the healthy CUSTOMER-issued row.
test('THE LIVE FIX: a broken google_calendar (INTERNAL) row must not block a healthy google_gmail (CUSTOMER) row', async () => {
  const rows = [
    { id: 'cal', updated_at: '2026-09-28T00:00:00Z', google_email: GOOGLE_ACCOUNT, refresh_token: 'rt-cal', oauth_provider: 'google_calendar' },
    { id: 'gmail', updated_at: '2026-09-19T00:00:00Z', google_email: GOOGLE_ACCOUNT, refresh_token: 'rt-gmail', oauth_provider: 'google_gmail' },
  ];
  const seenClientIds = [];
  const fetchImpl = async (url, init) => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const params = new URLSearchParams(init.body);
      seenClientIds.push(params.get('client_id'));
      const rt = params.get('refresh_token');
      if (rt === 'rt-cal') return jsonRes(401, { error: 'unauthorized_client' });
      return jsonRes(200, { access_token: 'tok', expires_in: 3600, scope: 'gmail.readonly' });
    }
    if (init && init.method === 'PATCH') return jsonRes(200, null);
    return jsonRes(200, rows);
  };

  const conditions = await checkGoogleTokenHealth({
    fetchImpl,
    sleepImpl: instantSleep,
    env: { ...ENV, internalClientId: 'internal-id', internalClientSecret: 'internal-secret' },
  });

  assert.deepEqual(conditions, [], 'the healthy google_gmail row recovers the integration -- nothing to alert on');
  assert.deepEqual(seenClientIds, ['internal-id', ENV.clientId], 'each provider must be tried with its OWN client, never the other\'s');
});

test('all_revoked: exactly one condition, states the count tried, names the fix, no secrets', async () => {
  const rows = [
    row('r1', '2026-09-26T00:00:00Z', 'rt-1'),
    row('r2', '2026-09-19T00:00:00Z', 'rt-2'),
    row('r3', '2026-09-12T00:00:00Z', 'rt-3'),
  ];
  const dead = { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
  const fetchImpl = makeFetch({ rows, googlePlan: { 'rt-1': [dead], 'rt-2': [dead], 'rt-3': [dead] } });

  const conditions = await checkGoogleTokenHealth({ fetchImpl, sleepImpl: instantSleep, env: ENV });

  assert.equal(conditions.length, 1);
  const c = conditions[0];
  assert.equal(c.key, 'google_token_refresh_failed');
  assert.match(c.message, /tried 3 stored credential/);
  assert.match(c.message, /all revoked/);
  assert.match(c.message, /meetdossie\.com\/myjarvis/);
  assert.match(c.message, /Connect Google Calendar/);
  for (const rt of ['rt-1', 'rt-2', 'rt-3']) assert.ok(!c.message.includes(rt));
  assert.ok(!c.message.includes(ENV.clientSecret));
});

test('every distinct failure state gets a DIFFERENT key -- one cooldown can never suppress a different problem', async () => {
  const noRowsConditions = await checkGoogleTokenHealth({ fetchImpl: makeFetch({ rows: [] }), sleepImpl: instantSleep, env: ENV });
  const misconfiguredConditions = await checkGoogleTokenHealth({ fetchImpl: async () => { throw new Error('must not be called'); }, sleepImpl: instantSleep, env: { ...ENV, clientSecret: '' } });
  const queryFailedConditions = await checkGoogleTokenHealth({ fetchImpl: async () => { throw new Error('ENOTFOUND'); }, sleepImpl: instantSleep, env: ENV });

  const rows = [row('r1', '2026-09-26T00:00:00Z', 'rt-1')];
  const clientConfigConditions = await checkGoogleTokenHealth({
    fetchImpl: makeFetch({ rows, googlePlan: { 'rt-1': [{ status: 401, body: { error: 'invalid_client' } }] } }),
    sleepImpl: instantSleep,
    env: ENV,
  });

  const rows2 = [row('r1', '2026-09-26T00:00:00Z', 'rt-1'), row('r2', '2026-09-19T00:00:00Z', 'rt-2')];
  const inconclusiveConditions = await checkGoogleTokenHealth({
    fetchImpl: makeFetch({ rows: rows2, googlePlan: { 'rt-1': [{ status: 400, body: { error: 'invalid_grant' } }], 'rt-2': [{ status: 500, body: {} }] } }),
    sleepImpl: instantSleep,
    env: ENV,
  });

  const persistFailedConditions = await checkGoogleTokenHealth({
    fetchImpl: makeFetch({ rows: [row('r1', '2026-09-26T00:00:00Z', 'rt-1')], googlePlan: { 'rt-1': [{ status: 200, body: { access_token: 'tok', expires_in: 3600 } }] }, failPatch: true }),
    sleepImpl: instantSleep,
    env: ENV,
  });

  const keys = [
    noRowsConditions[0].key,
    misconfiguredConditions[0].key,
    queryFailedConditions[0].key,
    clientConfigConditions[0].key,
    inconclusiveConditions[0].key,
    persistFailedConditions[0].key,
  ];
  assert.equal(new Set(keys).size, keys.length, `every failure state needs a distinct key, got: ${keys.join(', ')}`);
  assert.deepEqual(keys, [
    'google_token_missing_row',
    'google_token_check_misconfigured',
    'google_token_check_query_failed',
    'google_token_client_config_error',
    'google_token_check_inconclusive',
    'google_token_persist_failed',
  ]);
});

test('no condition ever carries a `reason`/message containing the word "refresh_token=" or a bearer-looking string', async () => {
  const rows = [row('r1', '2026-09-26T00:00:00Z', 'rt-super-secret-value')];
  const fetchImpl = makeFetch({ rows, googlePlan: { 'rt-super-secret-value': [{ status: 400, body: { error: 'invalid_grant' } }] } });
  const conditions = await checkGoogleTokenHealth({ fetchImpl, sleepImpl: instantSleep, env: ENV });
  const serialized = JSON.stringify(conditions);
  assert.ok(!serialized.includes('rt-super-secret-value'));
  assert.ok(!serialized.includes(ENV.clientSecret));
  assert.ok(!serialized.includes(ENV.serviceKey));
});
