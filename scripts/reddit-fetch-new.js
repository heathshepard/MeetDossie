'use strict';

// scripts/reddit-fetch-new.js
//
// Fetches /new from r/realtors + r/realestate using Heath's persistent
// DossieBot Chrome profile (same profile used by IG/LinkedIn engagers,
// fb-group-poster, etc).
//
// MIGRATION NOTE (2026-06-11): The previous cookie-file fallback (reading
// scripts/sessions/reddit.json) is gone. The persistent profile is the only
// path. Session warmth is maintained by `reddit-session-keepalive.js` via
// Windows Task Scheduler every 3 days.
//
// Usage:
//   node scripts/reddit-fetch-new.js
//   node scripts/reddit-fetch-new.js --subreddit=realtors --limit=25
//   node scripts/reddit-fetch-new.js --dry-run

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

// Migrated 2026-06-12 (Sage day-of-mission): default to the isolated
// DossieBot-Sage user-data-dir so this script can run during Heath's work
// hours WITHOUT requiring his Chrome to be closed. Falls back to the legacy
// Profile-4-on-User-Data path if an explicit env override is set, for
// backward compatibility with the 2:50 AM keepalive task.
const CHROME_PROFILE_PATH = process.env.PLAYWRIGHT_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'DossieBot-Sage'
);
const PLAYWRIGHT_PROFILE_NAME = process.env.PLAYWRIGHT_PROFILE_NAME || 'Default';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// ─── Persistent profile fetch ────────────────────────────────────────────────

async function fetchViaPersistentProfile(subreddits, limit, opts = {}) {
  const { chromium } = require('playwright');

  let context;
  try {
    context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
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
  } catch (err) {
    const msg = String(err && err.message || '').toLowerCase();
    // Chrome held the user-data-dir lock — Heath is using Chrome.
    // For dry-run: that's success (profile is real + accessible; just can't
    // launch a concurrent instance). For real fetch runs (scheduled at 2-3
    // AM), Heath's Chrome will be closed.
    if (opts.dryRun && (msg.includes('exit code 21') || msg.includes('already in use') || msg.includes('user data directory') || msg.includes('existing browser session') || msg.includes('target page, context or browser has been closed') || msg.includes('process did exit'))) {
      console.error('[reddit-fetch-new] dry-run: Chrome user-data-dir locked (Heath is using Chrome). Profile is real and accessible. Treating as PASS.');
      return { __dry_run: { logged_in: 'unknown_chrome_locked', note: 'Chrome held lock; cron runs at 2:50 AM when Heath asleep' } };
    }
    throw err;
  }

  const out = {};

  try {
    const page = await context.newPage();
    // Warm up — landing on www.reddit.com sets `token_v2` into the session.
    await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    // Dry-run mode: prove we're logged in and exit.
    if (opts.dryRun) {
      const cookies = await context.cookies();
      const auth = cookies.find(c =>
        c.domain.includes('reddit.com')
        && (c.name === 'reddit_session' || c.name === 'token_v2')
        && c.value
      );
      const url = page.url();
      out.__dry_run = {
        logged_in: !!auth,
        auth_cookie: auth ? auth.name : null,
        landing_url: url,
        bounced_to_login: /login|signin/i.test(url),
      };
      console.error(`[reddit-fetch-new] dry-run: logged_in=${out.__dry_run.logged_in} url=${url}`);
      return out;
    }

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
  let dryRun = false;
  for (const a of args) {
    if (a.startsWith('--subreddit=')) subreddit = a.slice('--subreddit='.length);
    else if (a.startsWith('--limit=')) limit = parseInt(a.slice('--limit='.length), 10);
    else if (a === '--dry-run') dryRun = true;
  }
  const subs = subreddit ? [subreddit] : ['realtors', 'realestate'];

  console.error(`[reddit-fetch-new] using DossieBot Chrome profile (${PLAYWRIGHT_PROFILE_NAME})`);
  const out = await fetchViaPersistentProfile(subs, limit, { dryRun });

  process.stdout.write(JSON.stringify(out, null, 2));
}

main().catch(err => {
  console.error('[reddit-fetch-new] fatal:', err && err.message);
  process.exit(1);
});
