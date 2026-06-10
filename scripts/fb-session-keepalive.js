'use strict';

// scripts/fb-session-keepalive.js
//
// Keeps Heath's Facebook session alive by opening his persistent Chrome
// profile every 3 days, navigating to facebook.com, confirming the c_user
// cookie is present, and exiting. FB invalidates sessions after ~60 days of
// inactivity; this guarantees we touch the session well before that.
//
// Runs on Windows Task Scheduler, NOT Vercel. Schedule:
//   schtasks /Create /TN "Dossie FB Session Keepalive" /TR
//     "node C:\Users\Heath Shepard\Desktop\MeetDossie\scripts\fb-session-keepalive.js"
//     /SC DAILY /MO 3 /ST 03:00
//
// Silent on success. If logged-out is detected, escalates to Cole (NOT Heath)
// via .cole-alerts.jsonl and the Claudy bot.
//
// Env vars (loaded from .env.local):
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID

const path = require('path');
const os = require('os');
const fs = require('fs');

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

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CHROME_PROFILE_PATH = path.join(
  os.homedir(),
  'AppData', 'Local', 'Google', 'Chrome', 'User Data'
);

const COLE_ALERT_FILE = path.join(__dirname, '..', '.cole-alerts.jsonl');

function ts() { return new Date().toISOString(); }

async function alertCole(message) {
  console.error(`[fb-keepalive] ALERT: ${message}`);
  try {
    fs.appendFileSync(COLE_ALERT_FILE, JSON.stringify({
      ts: new Date().toISOString(),
      source: 'fb-session-keepalive',
      severity: 'warn',
      message,
    }) + '\n');
  } catch {}
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: `Cole — FB keepalive failed: ${message}. Resolve without bothering Heath.`,
      }),
    });
  } catch {}
}

async function main() {
  const { chromium } = require('playwright');

  console.log(`[${ts()}] [fb-keepalive] Opening persistent Chrome profile...`);

  let context;
  try {
    context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
      ],
      viewport: { width: 1280, height: 900 },
      channel: 'chrome',
    });
  } catch (err) {
    // The most common cause of failure here is Chrome being open — we cannot
    // launch the persistent context if Chrome already owns the user-data-dir.
    // That's fine for a keep-alive: it means Heath is actively using Chrome,
    // which itself refreshes the session. Treat as success.
    const msg = String(err.message).toLowerCase();
    if (
      msg.includes('user data directory') ||
      msg.includes('existing browser session') ||
      msg.includes('already in use')
    ) {
      console.log(`[${ts()}] [fb-keepalive] Chrome is open (Heath using it). Session is being touched naturally. Done.`);
      process.exit(0);
    }
    await alertCole(`launchPersistentContext failed: ${err.message}`);
    process.exit(1);
  }

  const page = await context.newPage();

  try {
    await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    const currentUrl = page.url();
    const cookies = await context.cookies('https://www.facebook.com');
    const cUser = cookies.find(c => c.name === 'c_user' && c.value);

    if (currentUrl.includes('login') || currentUrl.includes('checkpoint') || !cUser) {
      await alertCole(
        `Chrome profile is logged OUT of Facebook (url=${currentUrl}, c_user=${cUser ? 'present' : 'missing'}). ` +
        `Recovery: open Chrome manually, log into facebook.com, then re-run this script to verify.`
      );
      await context.close();
      process.exit(1);
    }

    console.log(`[${ts()}] [fb-keepalive] Session healthy. c_user=${cUser.value.slice(0, 6)}…`);
    await context.close();
    process.exit(0);
  } catch (err) {
    await alertCole(`Navigation/check failed: ${err.message}`);
    try { await context.close(); } catch {}
    process.exit(1);
  }
}

main().catch(async (err) => {
  await alertCole(`Fatal: ${err.message}`);
  process.exit(1);
});
