'use strict';

// scripts/capture-facebook-session.js
//
// One-time setup: opens a visible browser window, lets Heath log into Facebook
// manually, then saves the session cookies to scripts/sessions/facebook.json.
// No Chrome profile required. Chrome does NOT need to be closed.
//
// Usage:
//   node scripts/capture-facebook-session.js
//
// After running once, post-founding-files.js will use the saved cookies.

const path = require('path');
const fs = require('fs');

try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
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
  }
} catch (e) {}

const SESSION_FILE = path.join(__dirname, 'sessions', 'facebook.json');
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const POLL_INTERVAL_MS = 2000;

async function main() {
  const { chromium } = require('playwright');

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  console.log('[capture-facebook-session] Launching browser...');

  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: null,
  });

  const page = await context.newPage();

  console.log('[capture-facebook-session] Navigating to Facebook...');
  await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('');
  console.log('Log into Facebook in the browser window that just opened. Come back here when you\'re on your Facebook feed.');
  console.log('');
  console.log('[capture-facebook-session] Waiting up to 3 minutes for login...');

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let loggedIn = false;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    try {
      const url = page.url();

      // If we're on a login page or still at the pre-login home, keep waiting
      if (url.includes('/login') || url.includes('login_attempt') || url.includes('checkpoint')) {
        continue;
      }

      if (!url.includes('facebook.com')) {
        continue;
      }

      // We're past login — check for feed-related elements that only appear when authenticated
      const feedVisible = await page.locator('div[role="feed"]').isVisible({ timeout: 500 }).catch(() => false);
      const navVisible = await page.locator('[aria-label="Facebook"]').isVisible({ timeout: 500 }).catch(() => false);
      const profileLinkVisible = await page.locator('a[href*="/me/"]').isVisible({ timeout: 500 }).catch(() => false);

      if (feedVisible || navVisible || profileLinkVisible) {
        loggedIn = true;
        break;
      }

      // Fallback: if URL looks like the authenticated home feed (not /login, has facebook.com)
      if (url === 'https://www.facebook.com/' || url === 'https://www.facebook.com') {
        // Give it one more check — the feed might still be loading
        await new Promise(resolve => setTimeout(resolve, 2000));
        const feedCheck = await page.locator('div[role="feed"]').isVisible({ timeout: 2000 }).catch(() => false);
        if (feedCheck) {
          loggedIn = true;
          break;
        }
      }
    } catch (e) {
      // Page may be mid-navigation — continue polling
    }
  }

  if (!loggedIn) {
    console.error('[capture-facebook-session] Timeout — no login detected within 3 minutes.');
    await browser.close();
    process.exit(1);
  }

  console.log('[capture-facebook-session] Login detected. Saving session...');

  try {
    await context.storageState({ path: SESSION_FILE });
    console.log(`Facebook session saved to scripts/sessions/facebook.json -- you can close the browser window.`);
  } catch (err) {
    console.error('[capture-facebook-session] Failed to save session:', err.message);
    await browser.close();
    process.exit(1);
  }

  await new Promise(resolve => setTimeout(resolve, 3000));
  await browser.close();
  process.exit(0);
}

main().catch(err => {
  console.error('[capture-facebook-session] Fatal error:', err.message);
  process.exit(1);
});
