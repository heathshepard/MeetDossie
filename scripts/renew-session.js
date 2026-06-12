'use strict';

// scripts/renew-session.js
//
// Re-captures a Playwright session cookie file for emergency / legacy use.
//
// MIGRATION NOTE (2026-06-11): Reddit / Instagram / LinkedIn no longer use
// cookie-file sessions. They run off Heath's persistent DossieBot Chrome
// profile and are kept warm by their session-keepalive.js scripts on
// Windows Task Scheduler. This renew tool now only supports `facebook`
// for legacy emergency paths.
//
// Usage:
//   node scripts/renew-session.js --site=facebook
//
// Site-specific credential env vars:
//   facebook   FACEBOOK_EMAIL  FACEBOOK_PASSWORD

const path = require('path');
const fs = require('fs');
const readline = require('readline');

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

const SITE_CONFIG = {
  facebook: {
    homeUrl: 'https://www.facebook.com',
    loginUrl: 'https://www.facebook.com/login',
    userField: '#email',
    passField: '#pass',
    submitSel: '[name="login"]',
    loggedInCookie: 'c_user',
    emailEnv: 'FACEBOOK_EMAIL',
    passEnv: 'FACEBOOK_PASSWORD',
    note: 'For Founding Files group posting, switch to MeetDossie Page after login before closing the browser. Use scripts/capture-facebook-session.js for that flow.',
  },
};

function parseArgs() {
  const args = process.argv.slice(2);
  let site = null;
  for (const a of args) {
    if (a.startsWith('--site=')) site = a.split('=')[1];
    else if (a === '--site' && args[args.indexOf(a) + 1]) site = args[args.indexOf(a) + 1];
  }
  return { site };
}

async function main() {
  const { site } = parseArgs();
  if (!site) {
    console.error('Usage: node scripts/renew-session.js --site=facebook');
    console.error('(reddit/instagram/linkedin now use the persistent Chrome profile — see scripts/<platform>-session-keepalive.js)');
    process.exit(1);
  }

  const cfg = SITE_CONFIG[site];
  if (!cfg) {
    console.error(`Unknown site: ${site}. Supported: ${Object.keys(SITE_CONFIG).join(', ')}`);
    process.exit(1);
  }

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const sessionFile = path.join(SESSIONS_DIR, `${site}.json`);

  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  const email = process.env[cfg.emailEnv];
  const password = process.env[cfg.passEnv];

  console.log(`[renew-session] Renewing ${site} session...`);
  if (cfg.note) console.log(`[renew-session] NOTE: ${cfg.note}`);

  await page.goto(cfg.homeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  if (email && password) {
    console.log(`[renew-session] Auto-login attempt using ${cfg.emailEnv}...`);
    try {
      await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
      await page.fill(cfg.userField, email);
      await page.waitForTimeout(500);
      await page.fill(cfg.passField, password);
      await page.waitForTimeout(500);
      await page.click(cfg.submitSel);
      console.log('[renew-session] Submitted. Waiting for login to complete...');
      await page.waitForTimeout(5000);
    } catch (err) {
      console.warn(`[renew-session] Auto-login error: ${err.message}`);
      console.log('[renew-session] Continuing in manual mode.');
    }
  } else {
    console.log(`[renew-session] No ${cfg.emailEnv} / ${cfg.passEnv} in .env.local.`);
    console.log('[renew-session] Log in manually in the browser window.');
  }

  // Wait for the auth cookie OR an ENTER override
  const loginDetected = new Promise(async (resolve) => {
    for (let i = 0; i < 180; i++) {
      await page.waitForTimeout(2000);
      try {
        const cookies = await context.cookies();
        if (cookies.some(c => c.name === cfg.loggedInCookie && c.value)) {
          resolve(true);
          return;
        }
      } catch {}
    }
    resolve(false);
  });

  const enterOverride = new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`(Press ENTER once logged in to ${site} to save now) > `, () => {
      rl.close();
      resolve(true);
    });
  });

  const ok = await Promise.race([loginDetected, enterOverride]);
  if (!ok) {
    console.error('[renew-session] Timed out without detecting login.');
    await browser.close();
    process.exit(1);
  }

  await context.storageState({ path: sessionFile });
  const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  const hasAuth = data.cookies.some(c => c.name === cfg.loggedInCookie && c.value);

  if (!hasAuth) {
    console.warn(`[renew-session] WARNING: ${cfg.loggedInCookie} cookie not found in saved session.`);
    console.warn('[renew-session] File saved anyway. You may need to retry.');
  } else {
    console.log(`[renew-session] Saved ${sessionFile} with ${data.cookies.length} cookies.`);
  }

  await page.waitForTimeout(2000);
  await browser.close();
  process.exit(0);
}

main().catch(err => {
  console.error('[renew-session] Fatal:', err.message);
  process.exit(1);
});
