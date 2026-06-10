'use strict';

// scripts/reddit-fetch-new.js
//
// Fetches /new from r/realtors + r/realestate using Heath's persistent
// DossieBot Chrome profile (same profile used by IG/LinkedIn engagers,
// fb-group-poster, etc). The previous version relied on a captured cookie
// file at scripts/sessions/reddit.json — that approach kept expiring and
// pinging Heath. The persistent profile fixes it: as long as the DossieBot
// Chrome profile stays logged into Reddit, this script keeps working
// indefinitely, refreshed by reddit-session-keepalive.js every 3 days.
//
// Cookie-file fallback: if `--use-cookie-file` is passed, OR
// `REDDIT_FETCH_MODE=cookie` is set, we fall through to the old behavior
// for emergency recovery. The default path is the persistent profile.
//
// Usage:
//   node scripts/reddit-fetch-new.js
//   node scripts/reddit-fetch-new.js --subreddit=realtors --limit=25
//   node scripts/reddit-fetch-new.js --use-cookie-file   # legacy

const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Env load ─────────────────────────────────────────────────────────────────

(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env.local');
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
const COOKIE_SESSION_FILE = path.join(__dirname, 'sessions', 'reddit.json');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// ─── Cookie-file fallback (legacy) ───────────────────────────────────────────

function buildCookieHeaderFromFile() {
  const data = JSON.parse(fs.readFileSync(COOKIE_SESSION_FILE, 'utf8'));
  const parts = [];
  for (const c of data.cookies || []) {
    if (!c.domain.includes('reddit.com')) continue;
    parts.push(`${c.name}=${c.value}`);
  }
  return parts.join('; ');
}

async function fetchViaCookieFile(subreddit, limit) {
  const cookie = buildCookieHeaderFromFile();
  const url = `https://www.reddit.com/r/${subreddit}/new.json?limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      Cookie: cookie,
    },
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) };
  let json;
  try { json = JSON.parse(text); } catch (e) {
    return { ok: false, status: res.status, error: `parse: ${e.message}; head=${text.slice(0, 200)}` };
  }
  const posts = (json?.data?.children || []).map(c => c.data).filter(Boolean);
  return { ok: true, status: res.status, posts };
}

// ─── Persistent profile (preferred) ──────────────────────────────────────────

async function fetchViaPersistentProfile(subreddits, limit) {
  const { chromium } = require('playwright');

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
    userAgent: USER_AGENT,
  });

  const out = {};

  try {
    const page = await context.newPage();
    // Warm up — landing on www.reddit.com sets `token_v2` into the session.
    await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    for (const sub of subreddits) {
      const url = `https://www.reddit.com/r/${sub}/new.json?limit=${limit}`;
      try {
        const data = await page.evaluate(async (u) => {
          const r = await fetch(u, {
            credentials: 'include',
            headers: { Accept: 'application/json, text/javascript, */*; q=0.01' },
          });
          const t = await r.text();
          return { status: r.status, ok: r.ok, text: t };
        }, url);
        if (!data.ok) {
          out[sub] = { ok: false, status: data.status, error: data.text.slice(0, 300) };
          console.error(`[reddit-fetch-new] r/${sub} FAILED ${data.status}: ${data.text.slice(0, 200)}`);
          continue;
        }
        let json;
        try { json = JSON.parse(data.text); } catch (e) {
          out[sub] = { ok: false, status: data.status, error: `parse: ${e.message}` };
          continue;
        }
        const posts = (json?.data?.children || []).map(c => c.data).filter(Boolean);
        out[sub] = { ok: true, status: data.status, posts };
        console.error(`[reddit-fetch-new] r/${sub}: ${posts.length} posts (persistent profile)`);
      } catch (err) {
        out[sub] = { ok: false, status: 0, error: err.message };
        console.error(`[reddit-fetch-new] r/${sub} threw: ${err.message}`);
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  return out;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let subreddit = null;
  let limit = 25;
  let mode = (process.env.REDDIT_FETCH_MODE || 'profile').toLowerCase();
  for (const a of args) {
    if (a.startsWith('--subreddit=')) subreddit = a.slice('--subreddit='.length);
    else if (a.startsWith('--limit=')) limit = parseInt(a.slice('--limit='.length), 10);
    else if (a === '--use-cookie-file') mode = 'cookie';
    else if (a === '--use-profile') mode = 'profile';
  }
  const subs = subreddit ? [subreddit] : ['realtors', 'realestate'];

  let out = {};
  if (mode === 'cookie' && fs.existsSync(COOKIE_SESSION_FILE)) {
    console.error('[reddit-fetch-new] using cookie-file mode (legacy)');
    for (const s of subs) {
      out[s] = await fetchViaCookieFile(s, limit);
    }
  } else {
    if (mode === 'cookie') {
      console.error('[reddit-fetch-new] cookie-file mode requested but no session file — falling back to profile');
    }
    console.error('[reddit-fetch-new] using DossieBot Chrome profile');
    out = await fetchViaPersistentProfile(subs, limit);
  }

  process.stdout.write(JSON.stringify(out, null, 2));
}

main().catch(err => {
  console.error('[reddit-fetch-new] fatal:', err && err.message);
  process.exit(1);
});
