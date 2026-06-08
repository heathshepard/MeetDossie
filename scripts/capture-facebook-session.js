'use strict';

// scripts/capture-facebook-session.js
//
// Opens a visible browser for Heath to log into Facebook.
// Auto-saves as soon as the c_user session cookie appears (no ENTER needed).
// Also accepts ENTER as a manual override.
//
// Usage: node scripts/capture-facebook-session.js

const path = require('path');
const fs = require('fs');
const readline = require('readline');

const SESSION_FILE = path.join(__dirname, 'sessions', 'facebook.json');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

async function main() {
  const { chromium } = require('playwright');

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  console.log('');
  console.log('[capture-facebook-session] Opening browser...');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('');
  console.log('=========================================');
  console.log('  Log into Facebook in the browser.');
  console.log('  Session saves automatically once you');
  console.log('  are logged in. No action needed here.');
  console.log('=========================================');
  console.log('');

  // Auto-detect login by polling for the c_user cookie (set when FB session is active)
  const autoSavePromise = new Promise(async (resolve) => {
    for (let i = 0; i < 180; i++) {
      await page.waitForTimeout(2000);
      try {
        const cookies = await context.cookies(['https://www.facebook.com']);
        const cUser = cookies.find(c => c.name === 'c_user' && c.value);
        if (cUser) {
          console.log('[capture-facebook-session] Login detected (c_user cookie found)! Saving...');
          resolve('auto');
          return;
        }
      } catch {
        // page may be navigating — keep polling
      }
    }
    console.log('[capture-facebook-session] 6-minute timeout reached without detecting login.');
    resolve('timeout');
  });

  // Also accept ENTER as manual override
  const enterPromise = new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('(Or press ENTER to save manually) > ', () => {
      rl.close();
      resolve('manual');
    });
  });

  const reason = await Promise.race([autoSavePromise, enterPromise]);
  console.log(`[capture-facebook-session] Saving session (${reason})...`);

  await context.storageState({ path: SESSION_FILE });

  const stat = fs.statSync(SESSION_FILE);
  const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  const hasCUser = data.cookies.some(c => c.name === 'c_user' && c.value);

  console.log('');
  console.log(`Session saved: scripts/sessions/facebook.json (${stat.size} bytes, ${data.cookies.length} cookies)`);

  if (!hasCUser) {
    console.log('WARNING: c_user cookie not found — you may not be fully logged in. Try again.');
  } else {
    console.log('c_user cookie present. Session is valid.');
    console.log('You can close the browser window now.');
  }
  console.log('');

  await browser.close();
  process.exit(hasCUser ? 0 : 1);
}

main().catch(err => {
  console.error('[capture-facebook-session] Error:', err.message);
  process.exit(1);
});
