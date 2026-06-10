'use strict';

// scripts/_lib/session-keepalive.js
//
// Shared keep-alive runner for IG / LinkedIn / Reddit / Twitter (and any
// future platform that uses the DossieBot persistent Chrome profile). The
// goal: NEVER ping Heath for a session-renewal again. The persistent profile
// preserves cookies indefinitely as long as Heath uses Chrome — keep-alive
// just makes sure they don't go stale on the platforms we automate.
//
// Behavior:
//   1. Launch the DossieBot Chrome profile (same one used by IG/LinkedIn
//      engagers, fb-group-poster, etc).
//   2. Navigate to a small list of platform URLs (home + one engagement
//      surface).
//   3. Probe `document.cookie` for the platform's "logged in" cookie name.
//   4. If found: mark healthy in scripts/sessions/keepalive-state.json,
//      reset consecutive-failure count to 0.
//   5. If missing: increment consecutive-failure count.
//   6. ONLY when consecutive failures hit ALERT_THRESHOLD (default 3),
//      ping the renewal-alert recipient (Cole's chat, fallback Heath's).
//      Cole can attempt recovery transparently before bothering Heath.
//
// Run frequency: every ~3 days via Windows Task Scheduler. Cookie lifetimes
// on these sites are generally 30 days+ but get refreshed by any visit,
// so 3 days is comfortable headroom.
//
// Usage:
//   const { runKeepalive } = require('./_lib/session-keepalive');
//   runKeepalive({ platform: 'instagram', urls: [...], cookieName: 'sessionid' });

const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Env load ─────────────────────────────────────────────────────────────────

(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '..', '..', '.env.local');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {}
})();

// ─── Config ──────────────────────────────────────────────────────────────────

const CHROME_PROFILE_PATH = process.env.PLAYWRIGHT_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'
);
const PLAYWRIGHT_PROFILE_NAME = process.env.PLAYWRIGHT_PROFILE_NAME || 'Profile 4';

const STATE_FILE = path.join(__dirname, '..', 'sessions', 'keepalive-state.json');
const STATE_DIR = path.dirname(STATE_FILE);

const ALERT_THRESHOLD = parseInt(process.env.SESSION_ALERT_THRESHOLD || '3', 10);

// Alert routing: Cole-first, then Heath as last resort.
//
// ATLAS_ALERT_CHAT_ID  - separate Telegram chat where Cole / Atlas
//                        can attempt recovery silently. Set this and the
//                        renewal pings stop bothering Heath entirely.
//
// If not set, the alerts fall back to TELEGRAM_CHAT_ID, but they only fire
// after ALERT_THRESHOLD consecutive failures (so a one-off logout from
// Chrome updating itself won't ping Heath).
const ALERT_BOT_TOKEN = process.env.ATLAS_ALERT_BOT_TOKEN
  || process.env.TELEGRAM_BOT_TOKEN
  || process.env.TELEGRAM_MARKETING_BOT_TOKEN;
const ALERT_CHAT_ID = process.env.ATLAS_ALERT_CHAT_ID
  || process.env.TELEGRAM_CHAT_ID;

// ─── State helpers ───────────────────────────────────────────────────────────

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[session-keepalive] Could not save state: ${err.message}`);
  }
}

function ts() {
  return new Date().toISOString();
}

// ─── Telegram alert ──────────────────────────────────────────────────────────

async function sendAlert(text, { silent = false } = {}) {
  if (!ALERT_BOT_TOKEN || !ALERT_CHAT_ID) {
    console.warn('[session-keepalive] No alert bot token or chat id configured — skipping Telegram alert.');
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${ALERT_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ALERT_CHAT_ID,
        text,
        disable_notification: silent,
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.warn(`[session-keepalive] Telegram alert failed: ${err.message}`);
  }
}

// ─── Browser probe ───────────────────────────────────────────────────────────

async function probeLogin({ platform, urls, cookieName, cookieDomain, screenshotPath }) {
  const { chromium } = require('playwright');

  console.log(`[${platform}-keepalive] Launching Chrome DossieBot profile (${PLAYWRIGHT_PROFILE_NAME})`);
  const context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      `--profile-directory=${PLAYWRIGHT_PROFILE_NAME}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ],
    viewport: { width: 1280, height: 900 },
    channel: 'chrome',
  });

  let loggedIn = false;
  let visitedAny = false;
  let lastUrl = null;
  const errors = [];

  try {
    const page = await context.newPage();

    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        // Settle a moment so any post-load redirect or cookie-set settles.
        await page.waitForTimeout(2500);
        visitedAny = true;
        lastUrl = page.url();
      } catch (err) {
        errors.push(`navigate ${url}: ${err.message}`);
        continue;
      }

      // Did we get bounced to a login page?
      if (/login|signin|sign-in|authwall|checkpoint/i.test(lastUrl || '')) {
        errors.push(`bounced to ${lastUrl} when visiting ${url}`);
        continue;
      }

      // Cookie probe.
      try {
        const cookies = await context.cookies();
        const match = cookies.find(c =>
          c.name === cookieName
          && c.value
          && (!cookieDomain || c.domain.includes(cookieDomain))
        );
        if (match) {
          loggedIn = true;
          break;
        }
      } catch (err) {
        errors.push(`cookie read ${url}: ${err.message}`);
      }
    }

    // Optional screenshot for diagnostic auditing
    if (screenshotPath && visitedAny) {
      try {
        await page.screenshot({ path: screenshotPath, fullPage: false });
      } catch {}
    }
  } finally {
    await context.close().catch(() => {});
  }

  return { loggedIn, visitedAny, lastUrl, errors };
}

// ─── Main runner ─────────────────────────────────────────────────────────────

async function runKeepalive({
  platform,
  urls,
  cookieName,
  cookieDomain,
  renewalCommand,
  screenshotPath,
}) {
  const state = loadState();
  const prev = state[platform] || { consecutive_failures: 0, last_healthy_at: null, last_run_at: null };

  console.log(`[${platform}-keepalive] ${ts()} starting — prev consecutive failures: ${prev.consecutive_failures}`);

  let result;
  try {
    result = await probeLogin({ platform, urls, cookieName, cookieDomain, screenshotPath });
  } catch (err) {
    console.error(`[${platform}-keepalive] probe threw: ${err.message}`);
    result = { loggedIn: false, visitedAny: false, lastUrl: null, errors: [err.message] };
  }

  const now = ts();
  const next = {
    last_run_at: now,
    last_healthy_at: result.loggedIn ? now : prev.last_healthy_at,
    consecutive_failures: result.loggedIn ? 0 : (prev.consecutive_failures + 1),
    last_errors: result.errors,
    last_url: result.lastUrl,
  };

  state[platform] = next;
  saveState(state);

  if (result.loggedIn) {
    console.log(`[${platform}-keepalive] HEALTHY — ${platform} session is still good.`);
    return { ok: true };
  }

  console.warn(`[${platform}-keepalive] UNHEALTHY (${next.consecutive_failures}/${ALERT_THRESHOLD}). Errors: ${JSON.stringify(result.errors)}`);

  if (next.consecutive_failures < ALERT_THRESHOLD) {
    console.warn(`[${platform}-keepalive] Below alert threshold — staying quiet. Will retry next run.`);
    return { ok: false, suppressed: true };
  }

  // Hit threshold — fire the renewal alert. Routed to Cole / Atlas chat if
  // ATLAS_ALERT_CHAT_ID is set, otherwise to Heath's normal Telegram.
  const cmd = renewalCommand || `node scripts/${platform}-session-keepalive.js`;
  const alertText = [
    `[atlas] ${platform} session needs recovery.`,
    `Detected logged-out state ${next.consecutive_failures} runs in a row.`,
    `Recovery path: open Chrome → DossieBot profile (${PLAYWRIGHT_PROFILE_NAME}) → log into ${platform}.`,
    `Or run: ${cmd}`,
    `Last URL probed: ${result.lastUrl || 'none'}`,
  ].join('\n');

  await sendAlert(alertText, { silent: false });
  console.warn(`[${platform}-keepalive] Alert dispatched to ${ALERT_CHAT_ID === process.env.ATLAS_ALERT_CHAT_ID ? 'Cole' : 'Heath'}.`);

  return { ok: false, alerted: true };
}

module.exports = {
  runKeepalive,
  CHROME_PROFILE_PATH,
  PLAYWRIGHT_PROFILE_NAME,
  STATE_FILE,
  ALERT_THRESHOLD,
};
