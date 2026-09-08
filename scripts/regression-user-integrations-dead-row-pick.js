#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-08-29 dead-token row pick
 * (user_integrations nondeterministic reader bug).
 *
 * THE FAILURE
 * -----------
 * user_integrations is unique on (user_id, oauth_provider) — NOT on
 * google_email. A Google re-consent can therefore leave TWO rows carrying
 * heath.shepard@kw.com: a dead one (revoked refresh token, 2026-08-03) and a
 * live one. Both scripts/kw-mail.py and api/gmail-refresh.js selected with an
 * UNORDERED limit=1, so they kept picking the dead row and every send failed
 * with invalid_grant while a perfectly good token sat unread. Confirmed live
 * 2026-08-29; an agent had to hand-delete the dead row to unblock a client
 * email. The Google consent screen is in Testing status (refresh tokens die
 * ~weekly), so the trap re-arms on every weekly re-consent.
 *
 * THE FIX (readers made deterministic — no rows deleted):
 *   - require refresh_token=not.is.null
 *   - order=updated_at.desc, limit=1
 *   - write-backs scoped to the exact row id (never by google_email/user_id,
 *     which would smear a Gmail token across google_youtube/microsoft rows)
 * Applied to: api/gmail-refresh.js, scripts/kw-mail.py,
 * api/cron-relevance-watcher.js, api/_lib/gmail-oauth.js,
 * scripts/preflight-check.js (gmail-send check).
 *
 * TESTS (all against a local mock PostgREST — ZERO production access):
 *   1. api/gmail-refresh.js with two rows (dead-first physical order, the
 *      order that reproduced the incident) refreshes using the LIVE row's
 *      token and PATCHes ONLY that row.
 *   2. api/_lib/gmail-oauth.js loadGoogleTokensForUser skips a newer row
 *      whose refresh_token is NULL and returns the older refreshable row.
 *   3. scripts/kw-mail.py honors the SUPABASE_URL override (static check
 *      first, so a pre-fix tree never phones production) and its
 *      access_token() caches the LIVE row's refresh token.
 *
 * Run manually:
 *   node scripts/regression-user-integrations-dead-row-pick.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..');
const KW = 'heath.shepard@kw.com';
const USER = '00000000-0000-4000-8000-0000000000aa';

// ------------------------------------------------------------ mock PostgREST
// Just enough of PostgREST for these readers: eq / not.is.null filters,
// order=updated_at.desc, limit. Crucially: with NO order param, rows come
// back in PHYSICAL order — exactly how the incident's dead row won.
let table = [];
const patched = []; // ids touched by PATCH, in order

function applyQuery(rows, params) {
  let out = rows.slice();
  for (const [k, v] of params) {
    if (k === 'select' || k === 'order' || k === 'limit') continue;
    if (v.startsWith('eq.')) {
      const want = decodeURIComponent(v.slice(3));
      out = out.filter((r) => String(r[k]) === want);
    } else if (v === 'not.is.null') {
      out = out.filter((r) => r[k] !== null && r[k] !== undefined);
    } else if (v === 'is.null') {
      out = out.filter((r) => r[k] === null || r[k] === undefined);
    }
  }
  const order = params.get('order');
  if (order === 'updated_at.desc') {
    out.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  } else if (order) {
    throw new Error(`mock does not implement order=${order}`);
  }
  const limit = params.get('limit');
  if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith('/rest/v1/user_integrations')) {
    res.writeHead(404).end('{}');
    return;
  }
  const params = u.searchParams;
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(applyQuery(table, params)));
    return;
  }
  if (req.method === 'PATCH') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const upd = JSON.parse(body || '{}');
      for (const row of applyQuery(table, params)) {
        Object.assign(row, upd);
        patched.push(row.id);
      }
      res.writeHead(204).end();
    });
    return;
  }
  res.writeHead(405).end();
});

// --------------------------------------------------- google token endpoint
// Only the LIVE token refreshes; the dead one gets the real-world
// invalid_grant. Everything non-Google passes through to real fetch (which,
// for this test, only ever means 127.0.0.1).
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    const params = new URLSearchParams(String(init && init.body));
    if (params.get('refresh_token') === 'LIVE-GOOD') {
      return new Response(JSON.stringify({ access_token: 'fresh-at', expires_in: 3600, scope: 'gmail.send' }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  }
  if (!u.startsWith('http://127.0.0.1')) {
    throw new Error(`network blocked by regression test: ${u.slice(0, 80)}`);
  }
  return realFetch(url, init);
};

function mockRes() {
  return {
    statusCode: null,
    body: null,
    setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
  };
}

const hr = (label) => console.log(`\n--- ${label}`);

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  process.env.SUPABASE_URL = base;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-key';
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.GOOGLE_CLIENT_ID = 'stub-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'stub-client-secret';

  // ---- 1. api/gmail-refresh.js picks the live row -------------------------
  hr('1. gmail-refresh: dead row first in physical order');
  table = [
    { id: 'dead-row', user_id: USER, oauth_provider: 'google_calendar', google_email: KW,
      access_token: 'dead-at', refresh_token: 'REVOKED-DEAD',
      updated_at: '2026-08-03T12:00:00Z', expires_at: '2026-08-03T13:00:00Z' },
    { id: 'live-row', user_id: USER, oauth_provider: 'google_gmail', google_email: KW,
      access_token: 'stale-at', refresh_token: 'LIVE-GOOD',
      updated_at: '2026-08-29T12:00:00Z', expires_at: '2026-08-29T13:00:00Z' },
  ];
  patched.length = 0;

  // ESM handler in a CJS repo: import a byte-identical temp .mjs copy of the
  // real file (it has no local imports). Env is already set above.
  const tmpMjs = path.join(os.tmpdir(), `gmail-refresh-under-test-${process.pid}.mjs`);
  fs.writeFileSync(tmpMjs, fs.readFileSync(path.join(REPO, 'api/gmail-refresh.js')));
  const handler = (await import(pathToFileURL(tmpMjs).href)).default;

  const res1 = mockRes();
  await handler(
    { method: 'GET', headers: { authorization: 'Bearer test-cron-secret' }, query: { email: KW } },
    res1
  );
  assert.strictEqual(res1.statusCode, 200,
    `gmail-refresh must pick the LIVE row; got ${res1.statusCode} ${JSON.stringify(res1.body)} ` +
    '(502 invalid_grant here = the dead row was picked — the exact 2026-08-29 incident)');
  assert.deepStrictEqual([...new Set(patched)], ['live-row'],
    `write-back must touch ONLY the refreshed row; patched: ${JSON.stringify(patched)}`);
  const deadRow = table.find((r) => r.id === 'dead-row');
  assert.strictEqual(deadRow.access_token, 'dead-at', 'dead row must not be clobbered by the write-back');
  console.log('OK — refreshed via LIVE-GOOD, patched only live-row');

  // ---- 2. gmail-oauth lib skips a newer null-refresh row ------------------
  hr('2. gmail-oauth.loadGoogleTokensForUser: newest row has NULL refresh_token');
  table = [
    { id: 'null-row', user_id: USER, oauth_provider: 'google_calendar', google_email: KW,
      access_token: 'orphan-at', refresh_token: null,
      updated_at: '2026-08-29T12:00:00Z', expires_at: null },
    { id: 'live-row-b', user_id: USER, oauth_provider: 'google_gmail', google_email: KW,
      access_token: 'ok-at', refresh_token: 'LIVE-GOOD',
      updated_at: '2026-08-28T12:00:00Z', expires_at: '2026-08-28T13:00:00Z' },
  ];
  const { loadGoogleTokensForUser } = require(path.join(REPO, 'api/_lib/gmail-oauth.js'));
  const picked = await loadGoogleTokensForUser(USER);
  assert.ok(picked, 'expected a row back');
  assert.strictEqual(picked.refresh_token, 'LIVE-GOOD',
    `must prefer the refreshable row over a newer null-refresh row; got ${JSON.stringify({ ...picked, access_token: '…', refresh_token: picked.refresh_token })}`);
  console.log('OK — returned the refreshable row, not the newer null-refresh one');

  // ---- 3. kw-mail.py picks the live row -----------------------------------
  hr('3. kw-mail.py access_token(): dead row first in physical order');
  const pySrc = fs.readFileSync(path.join(REPO, 'scripts/kw-mail.py'), 'utf8');
  assert.ok(pySrc.includes("os.environ.get('SUPABASE_URL')"),
    'kw-mail.py must honor a SUPABASE_URL override — without it this test cannot run it safely ' +
    'AND its production reads are the unordered pick that caused the incident');
  table = [
    { id: 'dead-row', user_id: USER, oauth_provider: 'google_calendar', google_email: KW,
      access_token: 'dead-at', refresh_token: 'REVOKED-DEAD',
      updated_at: '2026-08-03T12:00:00Z', expires_at: '2026-08-03T13:00:00Z' },
    { id: 'live-row', user_id: USER, oauth_provider: 'google_gmail', google_email: KW,
      access_token: 'live-at', refresh_token: 'LIVE-GOOD',
      updated_at: '2026-08-29T12:00:00Z', expires_at: '2026-08-29T13:00:00Z' },
  ];
  // async execFile — execFileSync would block the event loop and deadlock the
  // in-process mock server python is querying.
  const pyOut = await new Promise((resolve, reject) => {
    execFile('python3', ['-c', [
      'import importlib.util, json',
      `spec = importlib.util.spec_from_file_location('kwmail', ${JSON.stringify(path.join(REPO, 'scripts/kw-mail.py'))})`,
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'at = m.access_token()',
      "print(json.dumps({'at': at, 'rt': m._state.get('rt')}))",
    ].join('\n')], {
      env: { ...process.env, SUPABASE_URL: base, SR_KEY: 'stub-service-key' },
      encoding: 'utf8',
      timeout: 20000,
    }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message} ${String(stderr).slice(0, 200)}`)) : resolve(stdout)));
  });
  const py = JSON.parse(pyOut.trim().split('\n').pop());
  assert.strictEqual(py.rt, 'LIVE-GOOD',
    `kw-mail.py must cache the LIVE refresh token; got ${py.rt} (REVOKED-DEAD = the incident pick)`);
  assert.strictEqual(py.at, 'live-at', `kw-mail.py must read the LIVE row's access token; got ${py.at}`);
  console.log('OK — kw-mail.py picked the live row');

  fs.unlinkSync(tmpMjs);
  server.close();
  console.log('\nALL GREEN — dead-row pick regression covered.');
}

main().catch((e) => {
  console.error('\nREGRESSION FAILURE:', e.message);
  process.exit(1);
});
