'use strict';

// scripts/capture-facebook-session.js
//
// Captures a Facebook session for Playwright automation.
//
// If FACEBOOK_EMAIL + FACEBOOK_PASSWORD are set in .env.local, logs in
// automatically. Otherwise falls back to manual login (browser stays open,
// detects c_user cookie automatically — no ENTER needed).
//
// Usage: node scripts/capture-facebook-session.js

const path = require('path');
const fs = require('fs');
const readline = require('readline');

const SESSION_FILE = path.join(__dirname, 'sessions', 'facebook.json');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

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
    console.log('[capture-facebook-session] Credentials found — attempting auto-login...');
    try {
      // If already on the feed, skip login
      const cookies = await context.cookies(['https://www.facebook.com']);
      const alreadyLoggedIn = cookies.some(c => c.name === 'c_user' && c.value);

      if (!alreadyLoggedIn) {
        // Navigate to login page
        await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(1500);

        // Fill email
        await page.fill('#email', FB_EMAIL);
        await page.waitForTimeout(500);

        // Fill password
        await page.fill('#pass', FB_PASSWORD);
        await page.waitForTimeout(500);

        // Submit
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

  // Poll for c_user cookie (handles auto-login, 2FA, and manual login alike)
  console.log('[capture-facebook-session] Waiting for login (watching for c_user cookie)...');

  const autoSavePromise = new Promise(async (resolve) => {
    for (let i = 0; i < 180; i++) {
      await page.waitForTimeout(2000);
      try {
        const cookies = await context.cookies(['https://www.facebook.com']);
        const cUser = cookies.find(c => c.name === 'c_user' && c.value);
        if (cUser) {
          resolve('auto');
          return;
        }
      } catch {}
    }
    resolve('timeout');
  });

  // ENTER as manual override
  const enterPromise = new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('(Press ENTER to save manually if auto-detect stalls) > ', () => {
      rl.close();
      resolve('manual');
    });
  });

  const reason = await Promise.race([autoSavePromise, enterPromise]);

  if (reason === 'timeout') {
    console.error('[capture-facebook-session] Timed out without detecting login. Check browser.');
    await browser.close();
    process.exit(1);
  }

  console.log(`[capture-facebook-session] Saving session (${reason})...`);
  await context.storageState({ path: SESSION_FILE });

  const stat = fs.statSync(SESSION_FILE);
  const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  const hasCUser = data.cookies.some(c => c.name === 'c_user' && c.value);

  if (!hasCUser) {
    console.error('[capture-facebook-session] WARNING: c_user cookie missing — not fully logged in.');
    await browser.close();
    process.exit(1);
  }

  console.log(`Session saved: ${stat.size} bytes, ${data.cookies.length} cookies. c_user present.`);
  console.log('You can close the browser window now (or it will auto-close in 3s).');

  await page.waitForTimeout(3000);
  await browser.close();
  process.exit(0);
}

main().catch(err => {
  console.error('[capture-facebook-session] Error:', err.message);
  process.exit(1);
});
