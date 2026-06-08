'use strict';

// scripts/capture-facebook-session.js
//
// Captures a Facebook session for Playwright automation.
//
// IMPORTANT: You must switch to the MeetDossie Page before this saves.
// The script will check automatically and wait until you have switched.
//
// If FACEBOOK_EMAIL + FACEBOOK_PASSWORD are set in .env.local, logs in
// automatically. Otherwise falls back to manual login (browser stays open,
// detects c_user cookie automatically -- no ENTER needed).
//
// Usage: node scripts/capture-facebook-session.js

const path = require('path');
const fs = require('fs');
const readline = require('readline');

const SESSION_FILE = path.join(__dirname, 'sessions', 'facebook.json');
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const FOUNDING_FILES_URL = 'https://www.facebook.com/groups/860956437036808/';

// Selectors that indicate the post composer is visible (member of group, posting as Page)
const COMPOSER_SELECTORS = [
  '[aria-label*="Write something"]',
  '[aria-label*="What\'s on your mind"]',
  'div[role="main"] div[contenteditable="true"]',
];

// Load .env.local
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
} catch {}

const FB_EMAIL = process.env.FACEBOOK_EMAIL;
const FB_PASSWORD = process.env.FACEBOOK_PASSWORD;

async function main() {
  const { chromium } = require('playwright');

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  console.log('[capture-facebook-session] Opening browser...');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  if (FB_EMAIL && FB_PASSWORD) {
    console.log('[capture-facebook-session] Credentials found -- attempting auto-login...');
    try {
      const cookies = await context.cookies(['https://www.facebook.com']);
      const alreadyLoggedIn = cookies.some(c => c.name === 'c_user' && c.value);

      if (!alreadyLoggedIn) {
        await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(1500);
        await page.fill('#email', FB_EMAIL);
        await page.waitForTimeout(500);
        await page.fill('#pass', FB_PASSWORD);
        await page.waitForTimeout(500);
        await page.click('[name="login"]');
        console.log('[capture-facebook-session] Login submitted. Waiting for session...');
        await page.waitForTimeout(4000);
      }
    } catch (err) {
      console.warn('[capture-facebook-session] Auto-login step error:', err.message);
      console.log('[capture-facebook-session] Falling back to manual login...');
    }
  } else {
    console.log('');
    console.log('No FACEBOOK_EMAIL/FACEBOOK_PASSWORD found in .env.local.');
    console.log('Log into Facebook in the browser. Session saves automatically.');
    console.log('');
  }

  // Step 1: Wait for c_user cookie (confirms login)
  console.log('[capture-facebook-session] Waiting for login (watching for c_user cookie)...');

  const loginDetected = new Promise(async (resolve) => {
    for (let i = 0; i < 180; i++) {
      await page.waitForTimeout(2000);
      try {
        const cookies = await context.cookies(['https://www.facebook.com']);
        if (cookies.some(c => c.name === 'c_user' && c.value)) {
          resolve(true);
          return;
        }
      } catch {}
    }
    resolve(false);
  });

  const enterOverride = new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('(Press ENTER to advance manually if auto-detect stalls) > ', () => {
      rl.close();
      resolve(true);
    });
  });

  const loggedIn = await Promise.race([loginDetected, enterOverride]);

  if (!loggedIn) {
    console.error('[capture-facebook-session] Timed out without detecting login. Check browser.');
    await browser.close();
    process.exit(1);
  }

  // Step 2: Validate MeetDossie Page is active -- refuse to save until post composer appears
  console.log('');
  console.log('[capture-facebook-session] Login detected. Validating MeetDossie Page...');
  console.log('[capture-facebook-session] Navigating to Founding Files group...');
  console.log('');
  console.log('  IMPORTANT: You must switch to the MeetDossie Page before this saves.');
  console.log('  The script will check automatically and wait until you have switched.');
  console.log('');
  console.log('  If the post composer is not visible:');
  console.log('  1. Click your avatar (top-right of Facebook)');
  console.log('  2. Choose "Switch to Page" -> "MeetDossie"');
  console.log('  3. The script will detect the switch automatically.');
  console.log('');

  let composerFound = false;

  while (!composerFound) {
    try {
      await page.goto(FOUNDING_FILES_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);

      for (const sel of COMPOSER_SELECTORS) {
        const el = await page.$(sel);
        if (el) {
          composerFound = true;
          break;
        }
      }
    } catch {
      // Navigation error -- keep looping
    }

    if (composerFound) {
      console.log('[capture-facebook-session] MeetDossie Page confirmed. Post composer visible. Saving session...');
    } else {
      console.log('[capture-facebook-session] WRONG ACCOUNT -- post composer not visible.');
      console.log('You are logged in as your personal account, not the MeetDossie Page.');
      console.log('Steps: Click your avatar (top-right) -> "Switch to Page" -> "MeetDossie"');
      console.log(`Then navigate back to: ${FOUNDING_FILES_URL}`);
      console.log('Waiting for you to switch accounts... (checking every 10 seconds)');
      console.log('');
      await page.waitForTimeout(10000);
    }
  }

  // Save only after validation passes
  await context.storageState({ path: SESSION_FILE });

  const stat = fs.statSync(SESSION_FILE);
  const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  const hasCUser = data.cookies.some(c => c.name === 'c_user' && c.value);

  if (!hasCUser) {
    console.error('[capture-facebook-session] WARNING: c_user cookie missing -- not fully logged in.');
    await browser.close();
    process.exit(1);
  }

  console.log(`Session saved: ${stat.size} bytes, ${data.cookies.length} cookies. c_user present.`);
  console.log('MeetDossie Page session captured. The group poster will use this session.');
  console.log('You can close the browser window now (or it will auto-close in 3s).');

  await page.waitForTimeout(3000);
  await browser.close();
  process.exit(0);
}

main().catch(err => {
  console.error('[capture-facebook-session] Error:', err.message);
  process.exit(1);
});
