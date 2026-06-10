'use strict';

// scripts/capture-reddit-session.js
//
// Captures a Reddit session for Playwright automation.
//
// If REDDIT_USERNAME + REDDIT_PASSWORD are set in .env.local, logs in
// automatically. Otherwise falls back to manual login (browser stays open
// and detects the token_v2 / reddit_session cookie automatically).
//
// Usage: node scripts/capture-reddit-session.js

const path = require('path');
const fs = require('fs');
const readline = require('readline');

const SESSION_FILE = path.join(__dirname, 'sessions', 'reddit.json');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

// ─── Load .env.local ─────────────────────────────────────────────────────────

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

const REDDIT_USERNAME = process.env.REDDIT_USERNAME;
const REDDIT_PASSWORD = process.env.REDDIT_PASSWORD;

async function main() {
  const { chromium } = require('playwright');

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  console.log('[capture-reddit-session] Opening browser...');

  // Use a temp dir for the persistent context so we start clean
  const tempDir = require('os').tmpdir() + '/dossie-reddit-capture-' + Date.now();
  fs.mkdirSync(tempDir, { recursive: true });

  const context = await chromium.launchPersistentContext(tempDir, {
    headless: false,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ],
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  if (REDDIT_USERNAME && REDDIT_PASSWORD) {
    console.log('[capture-reddit-session] Credentials found — attempting auto-login...');
    try {
      await page.goto('https://www.reddit.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      // Fill username
      const usernameSelectors = ['input[name="username"]', '#loginUsername', 'input[id*="username"]'];
      let filledUser = false;
      for (const sel of usernameSelectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            await el.fill(REDDIT_USERNAME);
            filledUser = true;
            console.log(`[capture-reddit-session] Filled username via ${sel}`);
            break;
          }
        } catch {}
      }

      // Fill password
      const passwordSelectors = ['input[name="password"]', '#loginPassword', 'input[id*="password"]'];
      let filledPass = false;
      for (const sel of passwordSelectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            await el.fill(REDDIT_PASSWORD);
            filledPass = true;
            console.log(`[capture-reddit-session] Filled password via ${sel}`);
            break;
          }
        } catch {}
      }

      if (filledUser && filledPass) {
        await page.keyboard.press('Enter');
        console.log('[capture-reddit-session] Login submitted. Waiting for session...');
        await page.waitForTimeout(5000);
      } else {
        console.log('[capture-reddit-session] Could not find login form fields — waiting for manual login...');
      }
    } catch (err) {
      console.warn('[capture-reddit-session] Auto-login step error:', err.message);
      console.log('[capture-reddit-session] Falling back to manual login...');
    }
  } else {
    console.log('');
    console.log('No REDDIT_USERNAME/REDDIT_PASSWORD found in .env.local.');
    console.log('Log into Reddit in the browser. Session saves automatically.');
    console.log('');
  }

  // Poll for a logged-in indicator cookie (token_v2 or reddit_session)
  console.log('[capture-reddit-session] Waiting for login (watching for token_v2 cookie)...');

  const autoSavePromise = new Promise(async (resolve) => {
    for (let i = 0; i < 300; i++) {
      await page.waitForTimeout(2000);
      try {
        const cookies = await context.cookies(['https://www.reddit.com']);
        const loggedIn = cookies.find(
          (c) => (c.name === 'token_v2' || c.name === 'reddit_session') && c.value,
        );
        if (loggedIn) {
          resolve('auto');
          return;
        }
      } catch {}
    }
    resolve('timeout');
  });

  let reason;
  const isTTY = process.stdin.isTTY;
  if (isTTY) {
    const enterPromise = new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('(Press ENTER to save manually if auto-detect stalls) > ', () => {
        rl.close();
        resolve('manual');
      });
    });
    reason = await Promise.race([autoSavePromise, enterPromise]);
  } else {
    reason = await autoSavePromise;
  }

  if (reason === 'timeout') {
    console.error('[capture-reddit-session] Timed out without detecting login. Check browser.');
    await context.close();
    process.exit(1);
  }

  console.log(`[capture-reddit-session] Saving session (${reason})...`);
  await context.storageState({ path: SESSION_FILE });

  const stat = fs.statSync(SESSION_FILE);
  const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  const hasToken = data.cookies.some(
    (c) => (c.name === 'token_v2' || c.name === 'reddit_session') && c.value,
  );

  if (!hasToken) {
    console.error('[capture-reddit-session] WARNING: no auth cookie found — may not be fully logged in.');
    console.log('Session saved anyway. Test by running reddit-poster.js');
  } else {
    console.log(`Session saved: ${stat.size} bytes, ${data.cookies.length} cookies. Auth cookie present.`);
  }

  console.log('You can close the browser window now (or it will auto-close in 3s).');
  await page.waitForTimeout(3000);
  await context.close();

  // Clean up temp dir
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}

  process.exit(0);
}

main().catch((err) => {
  console.error('[capture-reddit-session] Error:', err.message);
  process.exit(1);
});
