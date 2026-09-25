#!/usr/bin/env node
'use strict';

// scripts/session-keepalive-gentle.js
//
// GENTLE SESSION KEEP-ALIVE (Atlas, 2026-09-25)
//
// Keeps the DossieBot / DossieBot-Sage browser sessions alive by touching each
// platform a FEW TIMES A DAY at irregular, human-looking times -- then leaving.
// It never posts, never scrapes, never likes, never comments.
//
// ── WHY GENTLE IS THE WHOLE POINT ────────────────────────────────────────────
// The sessions did not lapse on their own. scripts/linkedin-post-approved.log
// records Chrome launching and hitting linkedin.com/feed/ every 15 minutes --
// 96 times a day, on a metronome, from one IP, for days. An exact-interval
// access pattern is the cheapest possible automation tell, and it is precisely
// what a platform invalidates a session over. A session used at human cadence
// routinely survives for months.
//
// So the fix is not "touch it more often to keep it warm". It is "touch it much
// LESS often, and never on a schedule a machine would pick".
//
// ── THE CADENCE, AND WHY ─────────────────────────────────────────────────────
// THREE touches per channel per day, one inside each of three daytime windows:
//
//     morning    07:00 - 11:00      afternoon  13:00 - 17:00
//     evening    19:00 - 22:30
//
// Jitter is applied in three independent layers so no two days look alike and
// nothing ever lands on a round number:
//
//   1. Windows Task Scheduler RandomDelay (PT90M) on each of the three daily
//      triggers -- the OS itself smears the start time. See
//      scripts/register-session-keepalive-tasks.ps1.
//   2. A per-run random pre-delay of 0-7 minutes inside this script.
//   3. Randomised CHANNEL ORDER plus a random 45-180s gap between channels, so
//      the platforms are never visited in the same sequence or rhythm.
//
// Net effect: ~3 visits/day/channel at unpredictable minutes, versus 96/day on
// an exact quarter-hour. Roughly a 97% reduction in automated touches, and the
// remaining ones are not periodic.
//
// MIN_GAP_MINUTES is a floor, not a target: if a trigger fires close behind a
// previous one (RandomDelay can compress two windows together) the second is
// skipped rather than double-touching.
//
// ── HARD SAFETY RULES ────────────────────────────────────────────────────────
//   * NEVER logs in. No credentials are read, no Bitwarden, no 2FA, no form is
//     ever filled. Heath logs in by hand. An automated Facebook login trips a
//     checkpoint and risks his real account -- this script cannot do it because
//     the code to do it does not exist here.
//   * NEVER force-kills a Chrome holding the profile. If the profile is busy the
//     touch is SKIPPED and recorded as skipped. (2026-09-10: three same-day
//     collisions came from ignoring this.)
//   * Skips entirely when the profile is already logged out -- knocking on a
//     login wall repeatedly is the behaviour that caused this incident.
//   * Result goes to the credential_health TABLE, never only to a local file.
//
// Usage:
//   node scripts/session-keepalive-gentle.js                 # respect windows
//   node scripts/session-keepalive-gentle.js --now           # ignore window gating
//   node scripts/session-keepalive-gentle.js --dry-run       # no Chrome, no writes
//   node scripts/session-keepalive-gentle.js --channel linkedin_personal

const path = require('path');
const { loadEnvLocal } = require('./_lib/load-env-local.js');

loadEnvLocal(path.join(__dirname, '..'));

const { channels } = require('./_lib/session-profiles');
const { inspectChannel } = require('./_lib/session-guard');
const { writeHealth } = require('./_lib/credential-health-writer');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE_NOW = process.argv.includes('--now');
const ONLY = (() => {
  const i = process.argv.indexOf('--channel');
  return i !== -1 ? process.argv[i + 1] : null;
})();

// Daytime windows. Touches outside these never happen: a browser session that
// only ever wakes at 03:00 is its own kind of tell.
const WINDOWS = [
  { name: 'morning', start: 7 * 60, end: 11 * 60 },
  { name: 'afternoon', start: 13 * 60, end: 17 * 60 },
  { name: 'evening', start: 19 * 60, end: 22 * 60 + 30 },
];

const MIN_GAP_MINUTES = 150;   // refuse to touch again within 2.5h
const PRE_DELAY_MAX_MS = 7 * 60 * 1000;
const DWELL_MIN_MS = 4000;
const DWELL_MAX_MS = 12000;
const INTER_CHANNEL_MIN_MS = 45 * 1000;
const INTER_CHANNEL_MAX_MS = 180 * 1000;

const rand = (min, max) => min + Math.random() * (max - min);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(([, v]) => v);

function currentWindow(d = new Date()) {
  const m = d.getHours() * 60 + d.getMinutes();
  return WINDOWS.find((w) => m >= w.start && m <= w.end) || null;
}

/**
 * Should this channel be touched right now?
 * Gated on the clock window AND on how long it has been since the last touch,
 * which is read back from the database -- not from a local file. A file that
 * stops being written is invisible; a row that stops being updated is a finding.
 */
function shouldTouch(win, lastTouchIso) {
  if (FORCE_NOW) return { go: true, why: '--now' };
  if (!win) return { go: false, why: 'outside the 07:00-11:00 / 13:00-17:00 / 19:00-22:30 windows' };
  if (!lastTouchIso) return { go: true, why: `first touch (${win.name} window)` };
  const mins = (Date.now() - new Date(lastTouchIso).getTime()) / 60000;
  if (mins < MIN_GAP_MINUTES) {
    return { go: false, why: `last touch was ${Math.round(mins)}m ago; min gap is ${MIN_GAP_MINUTES}m` };
  }
  return { go: true, why: `${Math.round(mins)}m since last touch (${win.name} window)` };
}

/**
 * The lightest authenticated action that proves a session is alive:
 * load the logged-in home/feed, confirm an element that only renders when
 * authenticated, dwell briefly like a human would, leave.
 *
 * Returns logged_in true/false/null. NULL means "could not establish" -- which
 * is never treated as a failure, because an unknown is not a logout.
 */
async function touch(ch) {
  // 1. Never fight another agent for the profile.
  try {
    const { queryHoldingChromeProcesses } = require('./_lib/chrome-profile-unlock');
    const holders = queryHoldingChromeProcesses(String(ch.profile_dir).replace(/\//g, '\\'));
    if (holders && holders.length) {
      return { logged_in: null, skipped: true,
               detail: { skipped: 'profile held by a live Chrome — waiting, never killing', holders: holders.length } };
    }
  } catch (e) {
    return { logged_in: null, skipped: true, detail: { skipped: `could not verify profile is free: ${e.message.slice(0, 140)}` } };
  }

  let chromium;
  try {
    ({ chromium } = require('playwright-extra'));
    const stealth = require('puppeteer-extra-plugin-stealth')();
    chromium.use(stealth);
  } catch {
    try { ({ chromium } = require('playwright')); }
    catch { return { logged_in: null, skipped: true, detail: { skipped: 'playwright not installed' } }; }
  }

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(ch.profile_dir, {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        `--profile-directory=${ch.profile_name || 'Default'}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
      ],
      viewport: { width: 1280, height: 900 },
      channel: 'chrome',
    });
    const page = await ctx.newPage();
    await page.goto(ch.live_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(rand(2000, 4000));

    const landing = page.url();
    const urlOk = ch.live_ok(landing);

    // The authenticated-only element is the real proof. A 200 on a login page
    // is still a 200 -- the URL check alone has shipped false "healthy" before.
    let sawAuthElement = false;
    if (urlOk && ch.live_selector) {
      try {
        await page.waitForSelector(ch.live_selector, { timeout: 8000, state: 'attached' });
        sawAuthElement = true;
      } catch { sawAuthElement = false; }
    }

    // Dwell, then leave. No scrolling, no clicking, no engagement.
    await sleep(rand(DWELL_MIN_MS, DWELL_MAX_MS));

    // Soft-wall detection: the URL looks fine but the authenticated surface
    // never rendered. That is the degrading signal worth warning on BEFORE it
    // becomes a hard logout.
    const softWalled = urlOk && ch.live_selector && !sawAuthElement;

    return {
      logged_in: urlOk && sawAuthElement ? true : (urlOk ? null : false),
      soft_walled: softWalled,
      detail: {
        landing_url: landing,
        url_ok: urlOk,
        auth_element_found: sawAuthElement,
        note: softWalled
          ? 'URL looks logged-in but the authenticated element never rendered — possible soft-wall or partial session'
          : undefined,
      },
    };
  } catch (e) {
    return { logged_in: null, skipped: true, detail: { error: e.message.slice(0, 250) } };
  } finally {
    if (ctx) { try { await ctx.close(); } catch { /* ignore */ } }
  }
}

async function main() {
  const now = new Date();
  const win = currentWindow(now);
  const list = channels().filter((c) => !ONLY || c.channel === ONLY);

  console.log(`[keepalive] ${now.toISOString()} window=${win ? win.name : 'NONE'} channels=${list.length}${DRY_RUN ? ' [DRY RUN]' : ''}`);

  if (!win && !FORCE_NOW) {
    console.log('[keepalive] Outside all touch windows — exiting without launching anything.');
    return;
  }

  // Jitter layer 2: random pre-delay so the run does not begin the instant the
  // scheduler fires it.
  if (!DRY_RUN && !FORCE_NOW) {
    const wait = Math.round(rand(0, PRE_DELAY_MAX_MS));
    console.log(`[keepalive] pre-delay ${Math.round(wait / 1000)}s (jitter)`);
    await sleep(wait);
  }

  // Jitter layer 3: randomised channel order.
  const ordered = shuffle(list);
  let first = true;

  for (const ch of ordered) {
    if (!first && !DRY_RUN) {
      const gap = Math.round(rand(INTER_CHANNEL_MIN_MS, INTER_CHANNEL_MAX_MS));
      console.log(`[keepalive] inter-channel gap ${Math.round(gap / 1000)}s`);
      await sleep(gap);
    }
    first = false;

    // Offline cookie read first: free, and it decides whether a browser is even
    // worth opening.
    const cookie = inspectChannel(ch.channel);
    const prior = await readPrior(ch.channel);
    const gate = shouldTouch(win, prior.last_touch_at);

    let result = { logged_in: cookie.logged_in, skipped: true, detail: {} };
    let touched = false;

    if (cookie.logged_in === false) {
      console.log(`[keepalive] ${ch.channel}: LOGGED OUT (missing ${(cookie.missing || []).join('/')}) — not opening a browser. Heath must log in manually.`);
      result = { logged_in: false, skipped: true, detail: { reason: 'logged out per cookie DB; browser deliberately not launched' } };
    } else if (!gate.go) {
      console.log(`[keepalive] ${ch.channel}: skip — ${gate.why}`);
      result = { logged_in: cookie.logged_in, skipped: true, detail: { reason: gate.why } };
    } else if (DRY_RUN) {
      console.log(`[keepalive] ${ch.channel}: WOULD touch ${ch.live_url} — ${gate.why}`);
      result = { logged_in: cookie.logged_in, skipped: true, detail: { reason: 'dry-run' } };
    } else {
      console.log(`[keepalive] ${ch.channel}: touching ${ch.live_url} — ${gate.why}`);
      result = await touch(ch);
      touched = !result.skipped;
    }

    const status = result.logged_in === true ? 'HEALTHY'
      : result.logged_in === false ? 'LOGGED OUT' : 'UNKNOWN';
    console.log(`[keepalive] ${ch.channel}: ${status}${result.soft_walled ? ' (SOFT-WALL WARNING)' : ''}`);

    if (!DRY_RUN) {
      await writeHealth({
        channel: ch.channel,
        profile_dir: ch.profile_dir,
        probe_kind: touched ? 'keepalive_touch' : 'cookie_db',
        logged_in: result.logged_in,
        required_cookies: ch.required,
        present_cookies: cookie.present || [],
        earliest_expiry: cookie.earliest_expiry || null,
        days_to_expiry: cookie.days_to_expiry ?? null,
        touched,
        soft_walled: !!result.soft_walled,
        detail: { label: ch.label, window: win ? win.name : null, gate: gate.why, cookie_reason: cookie.reason, ...result.detail },
      });
    }
  }

  console.log('[keepalive] done.');
}

/** Last-touch bookkeeping lives in the DB so its absence is detectable. */
async function readPrior(channel) {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return {};
  try {
    const r = await fetch(`${url}/rest/v1/credential_health?channel=eq.${encodeURIComponent(channel)}&select=detail,last_probe_at,last_healthy_at,consecutive_failures`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!r.ok) return {};
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return {};
    return { last_touch_at: (row.detail && row.detail.last_touch_at) || null, ...row };
  } catch { return {}; }
}

if (require.main === module) {
  main().catch((e) => { console.error('[keepalive] fatal:', e.message); process.exit(1); });
}

module.exports = { WINDOWS, MIN_GAP_MINUTES, currentWindow, shouldTouch };
