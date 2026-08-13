#!/usr/bin/env node
'use strict';

// scripts/preflight-check.js
// =========================================================================
// PREFLIGHT CAPABILITY HEALTH CHECK — run this at session start.
//
//   node scripts/preflight-check.js
//   node scripts/preflight-check.js --json     # machine-readable output
//
// Runs a REAL minimal test of every capability an agent session tends to
// assume is working, and prints a compact status table. Read-only, safe to
// run repeatedly, targets < 30s wall clock (checks run in parallel).
//
// WHY THIS EXISTS
// ---------------
// On 2026-08-13 Gmail SEND was silently broken for the entire life of the
// integration — only gmail.readonly had ever been granted. Nothing surfaced
// it until it was needed mid-crisis, after hours of work had been built on
// the assumption that sending worked. The same class of failure applies to
// every item below: they fail *silently* and are only discovered at the
// moment you depend on them. Five seconds here beats hours there.
//
// CHECKS
//   gmail-send      user_integrations.scopes contains gmail.send (+ token not
//                   expired). Does NOT send mail — scope inspection only.
//   gmail-read      python3 scripts/kw-mail.py profile returns a real profile.
//   connectmls      Saved browser state has connectMLS auth cookies, unexpired.
//   zipform         Saved browser state has zipForm auth cookies, unexpired.
//   supabase        Service-role key from .env.local can actually query.
//   agent-queue     AgentQueuePoller Windows Scheduled Task is in Running state.
//   sms-freshness   Newest sms_messages.sent_at + how many hours stale.
//                   (Phone Link stops syncing silently; on 2026-08-13 it was
//                   18+ hours stale and nobody noticed until it mattered.)
//
// EXIT CODES: 0 = no FAILs (warnings allowed), 1 = at least one FAIL.
//
// SCOPE LIMIT — READ THIS BEFORE TRUSTING THE BROWSER ROWS
// --------------------------------------------------------
// connectmls/zipform here are a *cheap* check: they inspect the saved state
// file (cookie presence + expiry), they do not drive a browser. That catches
// "state file missing / cookies expired" but cannot catch a server-side
// invalidated session. For a definitive answer run the real durability check:
//     node scripts/brokerage-verify-and-save-state.js
// (not reused inline here: it launches two real browser contexts and WRITES
// the state file, which is neither fast nor read-only.)
//
// Owner: Atlas. Deliberately NOT wired to a SessionStart hook — ship manual,
// prove it, automate later.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const ENV_FILE = path.join(REPO, '.env.local');
// PREFLIGHT_STATE_FILE override exists so the FAIL paths can be exercised
// against a doctored fixture without touching Heath's real session state.
const STATE_FILE =
  process.env.PREFLIGHT_STATE_FILE ||
  path.join(os.homedir().startsWith('/home') ? '/mnt/c/Users/Heath' : os.homedir(), '.brokerage-browser-state.json');
const KW_ACCOUNT = 'heath.shepard@kw.com';
const SMS_STALE_WARN_HOURS = 12;
const TIMEOUT_MS = 25000;

const JSON_MODE = process.argv.includes('--json');

// ---------------------------------------------------------------- env parse
// .env.local carries a UTF-8 BOM that otherwise corrupts the FIRST key name,
// and contains duplicate keys — last value wins, matching dotenv-ish behavior.
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const raw = fs.readFileSync(ENV_FILE, 'utf8').replace(/^﻿/, '');
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return env;
}

const ENV = loadEnv();

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms).unref()),
  ]).catch((e) => ({ status: 'FAIL', detail: label, error: e.message }));
}

function sbFetch(pathAndQuery) {
  const url = ENV.SUPABASE_URL;
  const key = ENV.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env.local');
  return fetch(`${url}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
}

// ------------------------------------------------------------------- checks

async function checkSupabase() {
  const r = await sbFetch('profiles?select=id&limit=1');
  if (!r.ok) return { status: 'FAIL', error: `HTTP ${r.status} ${(await r.text()).slice(0, 120)}` };
  await r.json();
  return { status: 'OK', detail: 'service role key valid, query returned' };
}

async function checkGmailSend() {
  const r = await sbFetch(
    `user_integrations?select=scopes,expires_at,google_email&google_email=eq.${encodeURIComponent(KW_ACCOUNT)}&limit=1`
  );
  if (!r.ok) return { status: 'FAIL', error: `HTTP ${r.status}` };
  const rows = await r.json();
  if (!rows.length) return { status: 'FAIL', error: `no user_integrations row for ${KW_ACCOUNT}` };

  const row = rows[0];
  // scopes is stored as a single space-delimited STRING, not an array.
  const scopes = String(row.scopes || '').split(/\s+/).filter(Boolean);
  const has = (s) => scopes.some((x) => x === `https://www.googleapis.com/auth/${s}`);

  const missing = ['gmail.send', 'gmail.compose'].filter((s) => !has(s));
  const expMs = row.expires_at ? new Date(row.expires_at).getTime() : null;
  const expired = expMs !== null && expMs < Date.now();
  const minsLeft = expMs !== null ? Math.round((expMs - Date.now()) / 60000) : null;

  if (missing.length) {
    return {
      status: 'FAIL',
      error: `missing scope(s): ${missing.join(', ')} — sending will fail silently. Re-run OAuth consent.`,
    };
  }
  if (expired) {
    // kw-mail.py auto-refreshes, so this is a warning, not a hard fail.
    return { status: 'WARN', detail: `gmail.send granted, but access token expired ${-minsLeft}m ago (auto-refresh on next use)` };
  }
  return { status: 'OK', detail: `gmail.send + gmail.compose granted, token valid ${minsLeft}m` };
}

function checkGmailRead() {
  return new Promise((resolve) => {
    const key = ENV.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) return resolve({ status: 'FAIL', error: 'SUPABASE_SERVICE_ROLE_KEY missing (kw-mail.py needs SR_KEY)' });
    execFile(
      'python3',
      [path.join(REPO, 'scripts', 'kw-mail.py'), 'profile'],
      { cwd: REPO, timeout: TIMEOUT_MS - 2000, env: { ...process.env, SR_KEY: key } },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        if (err) {
          const msg = String(stderr || err.message).trim().split('\n').pop();
          return resolve({ status: 'FAIL', error: msg.slice(0, 160) });
        }
        if (!/messages/.test(out)) return resolve({ status: 'FAIL', error: `unexpected output: ${out.slice(0, 120)}` });
        return resolve({ status: 'OK', detail: out.split('\n').pop().slice(0, 90) });
      }
    );
  });
}

// Shared read of the saved browser state so both browser checks parse once.
let _state;
function readState() {
  if (_state !== undefined) return _state;
  try {
    _state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    _state = null;
  }
  return _state;
}

function checkSavedSession(label, domainRe, requiredCookies) {
  if (!fs.existsSync(STATE_FILE)) {
    return { status: 'FAIL', error: `state file missing: ${STATE_FILE}` };
  }
  const state = readState();
  if (!state) return { status: 'FAIL', error: `state file unreadable/corrupt: ${STATE_FILE}` };

  const nowSec = Date.now() / 1000;
  const cookies = (state.cookies || []).filter((c) => domainRe.test(c.domain || ''));
  if (!cookies.length) return { status: 'FAIL', error: `no ${label} cookies in saved state — never logged in or state overwritten` };

  const isLive = (c) => !c.expires || c.expires < 0 || c.expires > nowSec;
  const present = new Set(cookies.filter(isLive).map((c) => c.name));
  const missing = requiredCookies.filter((n) => !present.has(n));
  const expiredCount = cookies.filter((c) => !isLive(c)).length;

  const ageH = (Date.now() - fs.statSync(STATE_FILE).mtimeMs) / 3.6e6;
  const age = ageH < 48 ? `${ageH.toFixed(1)}h old` : `${(ageH / 24).toFixed(1)}d old`;

  if (missing.length) {
    return { status: 'FAIL', error: `auth cookie(s) gone/expired: ${missing.join(', ')} — re-login needed (state ${age})` };
  }
  return {
    status: 'OK',
    detail: `${present.size} live cookie(s), auth cookies present, state ${age}${expiredCount ? ` (${expiredCount} stale non-auth)` : ''}`,
  };
}

function checkScheduledTask() {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', "(Get-ScheduledTask -TaskName 'AgentQueuePoller' -ErrorAction Stop).State"],
      { timeout: TIMEOUT_MS - 5000 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message).trim().split('\n')[0];
          return resolve({ status: 'FAIL', error: `task not found or PowerShell unavailable: ${msg.slice(0, 120)}` });
        }
        const state = String(stdout || '').trim();
        if (state === 'Running') return resolve({ status: 'OK', detail: 'AgentQueuePoller Running' });
        return resolve({ status: 'FAIL', error: `AgentQueuePoller state is "${state}", expected Running` });
      }
    );
  });
}

async function checkSmsFreshness() {
  const r = await sbFetch('sms_messages?select=sent_at&order=sent_at.desc&limit=1');
  if (!r.ok) return { status: 'FAIL', error: `HTTP ${r.status}` };
  const rows = await r.json();
  if (!rows.length) return { status: 'FAIL', error: 'sms_messages is empty' };

  const newest = new Date(rows[0].sent_at);
  const hours = (Date.now() - newest.getTime()) / 3.6e6;
  const stamp = `newest ${newest.toISOString().replace('T', ' ').slice(0, 16)}Z, ${hours.toFixed(1)}h stale`;

  if (hours > SMS_STALE_WARN_HOURS) {
    return { status: 'WARN', detail: `${stamp} — Phone Link likely stopped syncing` };
  }
  return { status: 'OK', detail: stamp };
}

// --------------------------------------------------------------------- main

const CHECKS = [
  ['gmail-send', 'Gmail SEND scope', () => checkGmailSend()],
  ['gmail-read', 'Gmail READ (kw-mail)', () => checkGmailRead()],
  ['connectmls', 'connectMLS session', async () => checkSavedSession('connectMLS', /connectmls|mysolidearth/i, ['JSESSIONID', 'cf_clearance'])],
  ['zipform', 'zipForm session', async () => checkSavedSession('zipForm', /zipformplus/i, ['ASP.NET_SessionId', 'zfomid'])],
  ['supabase', 'Supabase service role', () => checkSupabase()],
  ['agent-queue', 'AgentQueuePoller task', () => checkScheduledTask()],
  ['sms-freshness', 'SMS sync freshness', () => checkSmsFreshness()],
];

const ICON = { OK: '✅', WARN: '⚠️ ', FAIL: '❌' };

async function main() {
  const t0 = Date.now();

  const results = await Promise.all(
    CHECKS.map(async ([id, label, fn]) => {
      const started = Date.now();
      let res;
      try {
        res = await withTimeout(Promise.resolve().then(fn), TIMEOUT_MS, id);
      } catch (e) {
        res = { status: 'FAIL', error: e.message };
      }
      if (!res || !res.status) res = { status: 'FAIL', error: 'check returned nothing' };
      return { id, label, ms: Date.now() - started, ...res };
    })
  );

  const fails = results.filter((r) => r.status === 'FAIL');
  const warns = results.filter((r) => r.status === 'WARN');

  if (JSON_MODE) {
    console.log(JSON.stringify({ ok: fails.length === 0, elapsedMs: Date.now() - t0, results }, null, 2));
  } else {
    const width = Math.max(...results.map((r) => r.label.length));
    console.log('\nPREFLIGHT — capability health check');
    console.log('-'.repeat(width + 56));
    for (const r of results) {
      const msg = r.status === 'FAIL' ? r.error : r.detail;
      console.log(`${ICON[r.status]}  ${r.label.padEnd(width)}  ${msg}`);
    }
    console.log('-'.repeat(width + 56));
    console.log(
      `${results.length - fails.length - warns.length} ok / ${warns.length} warn / ${fails.length} fail` +
        `  ·  ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );
    if (fails.length) console.log(`\nFAILING: ${fails.map((f) => f.id).join(', ')} — fix before building on these.`);
    console.log('');
  }

  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error('[preflight] fatal:', (e && e.stack) || e);
  process.exit(1);
});
