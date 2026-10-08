#!/usr/bin/env node
'use strict';

// scripts/credential-health-probe.js
//
// CREDENTIAL HEALTH PROBE (Atlas, 2026-09-25)
//
// Answers "are the browser sessions the marketing pipelines depend on actually
// alive?" and publishes the answer to Supabase credential_health, where the
// outcome monitor can act on it.
//
// WHY CENTRAL STORAGE IS THE POINT
// scripts/_lib/session-keepalive.js already tracked this -- in
// scripts/sessions/keepalive-state.json, on Heath's PC, and nowhere else. If
// the scheduled task simply stops running, no row exists to go stale, so the
// silence is invisible. That is how LinkedIn and Facebook stayed dead for 9
// days. Once the state lives in a table, a STALE PROBE is itself a finding.
//
// SAFETY -- this script never launches Chrome.
//   It copies the profile's cookie SQLite file to a temp path and reads it
//   read-only. No lock is taken, no live authenticated session is disturbed,
//   and the repo rule about never force-killing a Chrome holding a session
//   cannot be violated because no Chrome is touched at all.
//   Cookie VALUES are encrypted at rest and are never read or decrypted --
//   only host_key, name and expires_utc, which are plaintext metadata.
//
// TWO PROBE STRENGTHS, and the honest difference between them:
//   cookie_db   (implemented, default) -- is the session cookie PRESENT and
//               when does it expire? Catches the common case (logged out, or
//               about to lapse) with zero risk. Cannot catch a cookie the
//               server has invalidated: that looks identical to a good one.
//   live_action (implemented, --live, OFF by default) -- actually load the
//               platform and look for a logged-in surface. Strictly stronger,
//               because only the server can tell you a cookie is dead. It
//               launches Chrome on an exclusive profile, so it REQUIRES
//               `node scripts/agent-dispatch-preflight.js` to report the
//               profile free first, and this script enforces that itself.
//
// Usage:
//   node scripts/credential-health-probe.js            # cookie_db, read-only, safe anywhere
//   node scripts/credential-health-probe.js --live     # adds the authenticated-action probe
//   node scripts/credential-health-probe.js --dry-run  # print, write nothing
//
// Schedule: Windows Task Scheduler, daily. Cheap (~1s without --live).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { loadEnvLocal } = require('./_lib/load-env-local.js');

loadEnvLocal(path.join(__dirname, '..'));

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DRY_RUN = process.argv.includes('--dry-run');
const LIVE = process.argv.includes('--live');

// Chrome stores cookie expiry as microseconds since 1601-01-01. Note the value
// overflows a JS number, so every query below CASTs it to TEXT first -- reading
// it as an integer throws ERR_OUT_OF_RANGE on node:sqlite.
const CHROME_EPOCH_OFFSET_MS = 11644473600000;

function winHome() {
  // Under WSL the profiles live on the Windows side.
  const wsl = '/mnt/c/Users/Heath';
  if (fs.existsSync(wsl)) return wsl;
  return os.homedir();
}

// The channels the marketing pipelines actually depend on, and the cookie that
// proves each one is logged in.
//
// CORRECTED 2026-09-25 (Atlas): this list used to be declared inline here and
// asserted that ALL THREE channels live in the DossieBot-Sage profile. Two of
// them do not. linkedin-engager.js and instagram-engager.js both resolve
// PLAYWRIGHT_PROFILE_DIR (= C:\Users\Heath\DossieBot), and verified live today
// that directory holds the 9 linkedin.com cookies while the Sage profile holds
// zero. The probe was reading the wrong cookie database for linkedin_personal
// and instagram_engagement, so its verdict for those two was unrelated to the
// profile the pipelines actually use. The mapping now comes from
// scripts/_lib/session-profiles.js, which the pipelines' own resolution logic
// is mirrored into, so the probe cannot disagree with what it is probing.
const CHANNELS = require('./_lib/session-profiles').channels();

// The legacy local state file, folded in so a probe that already knows the
// answer is not thrown away. It is corroborating evidence, never the only
// source -- it is the file that could go stale silently in the first place.
const KEEPALIVE_STATE = path.join(__dirname, 'sessions', 'keepalive-state.json');

// ─── Cookie DB probe (read-only, never launches Chrome) ──────────────────────

function probeCookieDb(ch) {
  const dbPath = require('./_lib/session-profiles').cookieDbPath(ch.profile_dir, ch.profile_name);
  if (!fs.existsSync(dbPath)) {
    return { probe_kind: 'cookie_db', logged_in: null, present_cookies: [],
             detail: { error: 'cookie database not found', path: dbPath } };
  }
  const tmp = path.join(os.tmpdir(), `credprobe-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
  try {
    fs.copyFileSync(dbPath, tmp); // copy, never open the live file
    const db = new DatabaseSync(tmp, { readOnly: true });
    const rows = db.prepare(
      `SELECT host_key, name, CAST(expires_utc AS TEXT) AS expires_utc
         FROM cookies WHERE host_key LIKE ?`
    ).all(`%${ch.host_match}%`);
    db.close();

    const present = [];
    let earliest = null;
    for (const r of rows) {
      if (!ch.required.includes(r.name)) continue;
      present.push(r.name);
      const raw = Number(r.expires_utc);
      if (!raw) continue;
      const ms = raw / 1000 - CHROME_EPOCH_OFFSET_MS;
      if (ms > 0 && (earliest === null || ms < earliest)) earliest = ms;
    }
    const loggedIn = ch.required.every((c) => present.includes(c));
    const days = earliest ? (earliest - Date.now()) / 86400000 : null;
    return {
      probe_kind: 'cookie_db',
      logged_in: loggedIn,
      present_cookies: present,
      earliest_expiry: earliest ? new Date(earliest).toISOString() : null,
      days_to_expiry: days === null ? null : Math.round(days * 10) / 10,
      detail: {
        cookies_for_host: rows.length,
        host_cookie_names: rows.map((r) => r.name).slice(0, 25),
        note: loggedIn ? undefined
          : `no ${ch.required.filter((c) => !present.includes(c)).join('/')} cookie — this profile is logged out`,
      },
    };
  } catch (e) {
    return { probe_kind: 'cookie_db', logged_in: null, present_cookies: [],
             detail: { error: e.message.slice(0, 300) } };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

// ─── Live authenticated-action probe (opt-in, launches Chrome) ───────────────

/**
 * Strictly stronger than the cookie read, because a cookie the server has
 * invalidated is byte-identical to a good one. Gated behind the repo's own
 * preflight so it can never fight another agent for the profile.
 */
async function probeLive(ch) {
  try {
    const { queryHoldingChromeProcesses } = require('./_lib/chrome-profile-unlock');
    const holders = queryHoldingChromeProcesses(ch.profile_dir.replace(/\//g, '\\'));
    if (holders && holders.length) {
      return { probe_kind: 'live_action', logged_in: null,
               detail: { skipped: 'profile is held by a live Chrome — refusing to launch or kill it',
                         holders: holders.length } };
    }
  } catch (e) {
    // Cannot prove the profile is free. UNKNOWN is not FREE.
    return { probe_kind: 'live_action', logged_in: null,
             detail: { skipped: `could not verify profile is free: ${e.message.slice(0, 120)}` } };
  }

  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { return { probe_kind: 'live_action', logged_in: null, detail: { skipped: 'playwright not installed' } }; }

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(ch.profile_dir, {
      headless: true,
      args: ['--no-sandbox', `--profile-directory=${ch.profile_name || 'Default'}`],
      channel: 'chrome',
    });
    const page = await ctx.newPage();
    await page.goto(ch.live_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const url = page.url();
    return { probe_kind: 'live_action', logged_in: !!ch.live_ok(url), detail: { landing_url: url } };
  } catch (e) {
    return { probe_kind: 'live_action', logged_in: false, detail: { error: e.message.slice(0, 300) } };
  } finally {
    if (ctx) { try { await ctx.close(); } catch { /* ignore */ } }
  }
}

// ─── Persist ─────────────────────────────────────────────────────────────────

async function upsert(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/credential_health?on_conflict=channel`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  return { ok: res.ok, status: res.status, text: res.ok ? '' : await res.text() };
}

async function existingRows() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/credential_health?select=channel,consecutive_failures,last_healthy_at`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!res.ok) return {};
    const arr = await res.json();
    return Object.fromEntries(arr.map((r) => [r.channel, r]));
  } catch { return {}; }
}

function readKeepaliveState() {
  try { return JSON.parse(fs.readFileSync(KEEPALIVE_STATE, 'utf8')); } catch { return {}; }
}

async function main() {
  const prior = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) ? await existingRows() : {};
  const keepalive = readKeepaliveState();
  const now = new Date().toISOString();
  const payload = [];

  for (const ch of CHANNELS) {
    let probe = probeCookieDb(ch);
    if (LIVE) {
      const live = await probeLive(ch);
      // A live probe that reached a verdict always wins -- only the server can
      // say a present cookie is dead.
      if (live.logged_in !== null) {
        probe = { ...probe, ...live, detail: { cookie_db: probe.detail, live_action: live.detail } };
      } else {
        probe.detail = { cookie_db: probe.detail, live_action: live.detail };
      }
    }

    const p = prior[ch.channel] || {};
    const healthy = probe.logged_in === true;
    const ka = keepalive[ch.channel.split('_')[0]] || keepalive[ch.channel] || null;

    payload.push({
      channel: ch.channel,
      profile_dir: ch.profile_dir,
      probe_kind: probe.probe_kind,
      logged_in: probe.logged_in,
      required_cookies: ch.required,
      present_cookies: probe.present_cookies || [],
      earliest_expiry: probe.earliest_expiry || null,
      days_to_expiry: probe.days_to_expiry ?? null,
      consecutive_failures: healthy ? 0 : (Number(p.consecutive_failures) || 0) + 1,
      last_probe_at: now,
      last_healthy_at: healthy ? now : (p.last_healthy_at || null),
      detail: {
        label: ch.label,
        ...probe.detail,
        legacy_keepalive_state: ka ? {
          last_run_at: ka.last_run_at, last_healthy_at: ka.last_healthy_at,
          consecutive_failures: ka.consecutive_failures, last_reason: ka.last_reason,
        } : undefined,
      },
      updated_at: now,
    });
  }

  for (const r of payload) {
    const status = r.logged_in === true ? 'OK'
      : r.logged_in === false ? 'LOGGED OUT' : 'UNKNOWN';
    const expiry = r.days_to_expiry === null ? '' : ` | expires in ${r.days_to_expiry}d`;
    console.log(`[credential-health] ${r.channel.padEnd(22)} ${status.padEnd(11)} ` +
                `cookies=${(r.present_cookies || []).join(',') || 'none'}/${r.required_cookies.join(',')}` +
                `${expiry} | consecutive_failures=${r.consecutive_failures}`);
  }

  if (DRY_RUN) { console.log('\n[credential-health] --dry-run: nothing written'); return; }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[credential-health] Supabase not configured — printed only, nothing written');
    process.exitCode = 1;
    return;
  }

  // Written one row at a time through the shared writer so this script and
  // session-keepalive-gentle.js classify status, accumulate consecutive_failures
  // and preserve last_touch_at by exactly the same rules. Two writers with two
  // sets of semantics on one table is how the next silent drift would start.
  const { writeHealth } = require('./_lib/credential-health-writer');
  let failures = 0;
  for (const r of payload) {
    const res = await writeHealth({
      channel: r.channel,
      profile_dir: r.profile_dir,
      probe_kind: r.probe_kind,
      logged_in: r.logged_in,
      required_cookies: r.required_cookies,
      present_cookies: r.present_cookies,
      earliest_expiry: r.earliest_expiry,
      days_to_expiry: r.days_to_expiry,
      // A --live run really does load the page, so it counts as a touch.
      touched: LIVE && r.probe_kind === 'live_action',
      soft_walled: false,
      detail: r.detail,
    });
    if (!res.ok) failures++;
  }
  console.log(`\n[credential-health] wrote ${payload.length - failures}/${payload.length} rows`);
  if (failures) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((e) => { console.error('[credential-health] fatal:', e.message); process.exit(1); });
}

module.exports = { CHANNELS, probeCookieDb, CHROME_EPOCH_OFFSET_MS };
