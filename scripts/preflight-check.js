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
//   gmail-send      REAL SMTP AUTH LOGIN against smtp.gmail.com using
//                   KW_MAIL_APP_PASSWORD (the primary send path as of
//                   2026-09-28) — genuinely authenticates, sends nothing.
//                   OK only comes from that real auth succeeding. If the app
//                   password is missing/rejected this falls back to
//                   inspecting user_integrations.scopes for gmail.send (the
//                   OLD check) — but that fallback is capped at WARN, never
//                   OK, because scope presence was exactly the thing that
//                   lied on 2026-08-13 (gmail.send scope had never been
//                   granted and nothing caught it for the integration's
//                   entire life). A green gmail-send now always means a
//                   verified credential actually authenticated somewhere.
//   gmail-read      python3 scripts/kw-mail.py profile returns a real profile
//                   (IMAP app-password primary, OAuth Gmail API fallback —
//                   the detail line reports which one actually answered).
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

// Minimal SMTP AUTH LOGIN probe over raw TLS — stdlib only (Node's `tls`),
// no nodemailer dependency. Authenticates for real and immediately closes;
// never issues MAIL FROM/RCPT TO/DATA, so nothing is ever sent. This is the
// genuine send-capability proof that the old scope-inspection check never
// was.
function smtpAppPasswordProbe(account, password, timeoutMs) {
  const tls = require('tls');
  return new Promise((resolve) => {
    let buf = '';
    let step = 0; // 0=greeting 1=EHLO 2=AUTH LOGIN 3=username 4=password/result
    let settled = false;
    let socket;
    const timer = setTimeout(() => finish({ ok: false, error: `timed out after ${timeoutMs}ms` }), timeoutMs).unref();
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.end(); } catch (_) {}
      resolve(result);
    }
    try {
      socket = tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com', timeout: timeoutMs });
    } catch (e) {
      return finish({ ok: false, error: e.message });
    }
    socket.setEncoding('utf8');
    socket.on('error', (e) => finish({ ok: false, error: e.message }));
    socket.on('timeout', () => finish({ ok: false, error: 'socket timeout' }));
    socket.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (!/^\d{3} /.test(last)) return; // multi-line response still incoming
      const code = last.slice(0, 3);
      buf = '';
      if (step === 0) {
        if (code !== '220') return finish({ ok: false, error: `bad greeting: ${last}` });
        step = 1;
        socket.write('EHLO localhost\r\n');
      } else if (step === 1) {
        if (code !== '250') return finish({ ok: false, error: `EHLO failed: ${last}` });
        step = 2;
        socket.write('AUTH LOGIN\r\n');
      } else if (step === 2) {
        if (code !== '334') return finish({ ok: false, error: `AUTH LOGIN not offered: ${last}` });
        step = 3;
        socket.write(Buffer.from(account).toString('base64') + '\r\n');
      } else if (step === 3) {
        if (code !== '334') return finish({ ok: false, error: `username rejected: ${last}` });
        step = 4;
        socket.write(Buffer.from(password).toString('base64') + '\r\n');
      } else if (step === 4) {
        if (code === '235') return finish({ ok: true });
        return finish({ ok: false, error: `auth rejected: ${last}` });
      }
    });
  });
}

async function checkGmailSend() {
  const pwRaw = ENV.KW_MAIL_APP_PASSWORD || process.env.KW_MAIL_APP_PASSWORD;
  let appPwNote;
  if (pwRaw) {
    const pw = pwRaw.replace(/ /g, '');
    const probe = await smtpAppPasswordProbe(KW_ACCOUNT, pw, Math.max(TIMEOUT_MS - 8000, 8000));
    if (probe.ok) {
      return {
        status: 'OK',
        detail: `SMTP AUTH LOGIN verified via KW_MAIL_APP_PASSWORD (real login, nothing sent) — primary send path is live`,
      };
    }
    appPwNote = `KW_MAIL_APP_PASSWORD present but REJECTED (${probe.error}) — checking OAuth fallback scopes: `;
  } else {
    appPwNote = 'KW_MAIL_APP_PASSWORD not set — checking OAuth fallback scopes: ';
  }

  // Fallback: the old scope-inspection check. Same deterministic row pick as
  // kw-mail.py / api/gmail-refresh.js: the table is unique on
  // (user_id, oauth_provider), not google_email, so an unordered limit=1
  // could inspect a stale duplicate row's scopes instead of the row sends
  // will actually use.
  const r = await sbFetch(
    `user_integrations?select=scopes,expires_at,google_email&google_email=eq.${encodeURIComponent(KW_ACCOUNT)}`
    + `&refresh_token=not.is.null&order=updated_at.desc&limit=1`
  );
  if (!r.ok) return { status: 'FAIL', error: appPwNote + `HTTP ${r.status}` };
  const rows = await r.json();
  if (!rows.length) return { status: 'FAIL', error: appPwNote + `no user_integrations row for ${KW_ACCOUNT}` };

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
      error: appPwNote + `missing scope(s): ${missing.join(', ')} — sending is dead on BOTH paths. Set KW_MAIL_APP_PASSWORD or re-run OAuth consent.`,
    };
  }
  // Deliberately capped at WARN, never OK, even when everything here looks
  // right — scope presence is not a real send test and was exactly what lied
  // silently for this integration's whole life until 2026-08-13. Fix the app
  // password to get a genuine OK.
  if (expired) {
    return {
      status: 'WARN',
      detail: appPwNote + `gmail.send scope present, token expired ${-minsLeft}m ago — UNVERIFIED, scope-only (not a real send test)`,
    };
  }
  return {
    status: 'WARN',
    detail: appPwNote + `gmail.send + gmail.compose scopes present, token valid ${minsLeft}m — UNVERIFIED, scope-only (not a real send test)`,
  };
}

// Python only exists in WSL here — there is no Windows-side install, and on
// Windows 'python3' resolves to the Microsoft Store stub, which made this
// check FAIL ("Python was not found") on a perfectly healthy system whenever
// preflight ran under Windows node (seen 2026-08-29). A false alarm trains
// everyone to ignore preflight, which is worse than no check — so route the
// invocation to WSL python3, the interpreter kw-mail.py actually runs under.
function pythonInvocation(scriptPath, scriptArgs) {
  if (process.platform !== 'win32') {
    return { cmd: 'python3', argv: [scriptPath, ...scriptArgs], extraEnv: {} };
  }
  // C:\...\kw-mail.py -> /mnt/c/.../kw-mail.py; WSLENV forwards the secrets
  // across the Windows->WSL boundary (/u = Win32-to-WSL only).
  const wslPath = scriptPath
    .replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`)
    .replace(/\\/g, '/');
  return {
    cmd: 'wsl.exe',
    argv: ['-d', 'Ubuntu', '--', 'python3', wslPath, ...scriptArgs],
    extraEnv: { WSLENV: [process.env.WSLENV, 'SR_KEY/u', 'CRON_SECRET/u'].filter(Boolean).join(':') },
  };
}

function checkGmailRead() {
  return new Promise((resolve) => {
    const key = ENV.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) return resolve({ status: 'FAIL', error: 'SUPABASE_SERVICE_ROLE_KEY missing (kw-mail.py OAuth fallback needs SR_KEY)' });
    const inv = pythonInvocation(path.join(REPO, 'scripts', 'kw-mail.py'), ['profile']);
    // Deliberately do NOT inject KW_MAIL_APP_PASSWORD here. kw-mail.py now
    // loads .env.local itself (2026-09-28 fix) — injecting the credential
    // from THIS script's own .env.local parse would let the two loaders
    // diverge silently again, exactly the false-green bug that hid the
    // original silent-OAuth-fallback defect: this check reported OK because
    // preflight force-fed the password into the child, while a bare
    // `python3 scripts/kw-mail.py profile` (no injection) fell back to
    // OAuth every time. Both paths must resolve the credential the SAME
    // way — through kw-mail.py's own loader — or this check is lying.
    execFile(
      inv.cmd,
      inv.argv,
      {
        cwd: REPO,
        timeout: TIMEOUT_MS - 2000,
        env: {
          ...process.env,
          SR_KEY: key,
          ...(ENV.CRON_SECRET && !process.env.CRON_SECRET ? { CRON_SECRET: ENV.CRON_SECRET } : {}),
          ...inv.extraEnv,
        },
      },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        const errOut = String(stderr || '').trim();
        if (err) {
          const msg = (errOut || err.message).trim().split('\n').pop();
          return resolve({ status: 'FAIL', error: msg.slice(0, 160) });
        }
        if (!/messages/.test(out)) return resolve({ status: 'FAIL', error: `unexpected output: ${out.slice(0, 120)}` });
        const lastLine = out.split('\n').pop().slice(0, 95);
        // kw-mail.py's own output says which path actually answered — surface
        // it here instead of re-deriving it, so this can never drift from
        // what the script actually did. Format as of the 2026-09-28 loud-
        // fallback fix: "[LABEL: app-password <context> (<reason>) — falling
        // back to OAuth]" where LABEL is CONFIG / CREDENTIAL REJECTED BY
        // GOOGLE / CONNECTION.
        const fallbackMatch = errOut.match(/^\[([A-Z ]+): app-password (?:IMAP failed|unavailable|SMTP prep\/auth failed) \((.+?)\)/);
        const fallbackLabel = fallbackMatch && fallbackMatch[1];
        const fallbackReason = fallbackMatch && fallbackMatch[2];
        const usedAppPassword = /\(IMAP app-password\)/.test(out);
        const usedOAuth = /\(OAuth Gmail API\)/.test(out);
        const via = usedAppPassword
          ? 'KW_MAIL_APP_PASSWORD (IMAP, primary)'
          : usedOAuth
            ? `OAuth (fallback${fallbackReason ? ' — ' + fallbackLabel + ': ' + fallbackReason.slice(0, 70) : ''})`
            : 'unknown';

        // "Configured but unused": preflight's OWN .env.local read (ENV,
        // parsed independently above) sees a value, but the script that
        // actually answered used OAuth instead. That divergence is exactly
        // the failure class this check exists to catch — it must never
        // read OK just because *some* credential worked.
        if (usedOAuth && ENV.KW_MAIL_APP_PASSWORD) {
          const severity = fallbackLabel && fallbackLabel.includes('CREDENTIAL') ? 'FAIL' : 'WARN';
          return resolve({
            status: severity,
            error:
              `KW_MAIL_APP_PASSWORD is set in .env.local but kw-mail.py used OAuth instead`
              + (fallbackLabel ? ` [${fallbackLabel}: ${fallbackReason ? fallbackReason.slice(0, 90) : 'no detail'}]` : '')
              + ` — app-password path is configured-but-unused.`,
          });
        }
        return resolve({ status: 'OK', detail: `${lastLine}  [via ${via}]` });
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
