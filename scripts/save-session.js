'use strict';

// scripts/save-session.js
//
// One-time setup: launches Chrome Profile 4 (DossieBot) via Playwright,
// exports session storage state to scripts/sessions/<platform>.json.
// Run ONCE with Chrome fully closed. After this, the scanners use saved
// cookies and never need Chrome to be closed again.
//
// Usage:
//   node scripts/save-session.js [platform]
//
// Platforms: twitter, instagram, linkedin, facebook (default: all)
//
// IMPORTANT: Close Chrome completely before running this.

const path = require('path');
const os = require('os');
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

const CHROME_PROFILE_PATH = process.env.PLAYWRIGHT_PROFILE_DIR ||
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const PROFILE_NAME = process.env.PLAYWRIGHT_PROFILE_NAME || 'Profile 4';

const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const PLATFORM_URLS = {
  twitter: 'https://x.com/home',
  instagram: 'https://www.instagram.com/',
  linkedin: 'https://www.linkedin.com/feed/',
  facebook: 'https://www.facebook.com/',
};

async function savePlatformSession(context, platform, url) {
  const page = await context.newPage();
  console.log(`[save-session] Navigating to ${platform}...`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
  } catch (e) {
    console.log(`[save-session] Navigation timeout for ${platform} (ok)`);
  }

  const storageFile = path.join(SESSIONS_DIR, `${platform}.json`);
  await context.storageState({ path: storageFile });
  console.log(`[save-session] Saved ${platform} session to ${storageFile}`);
  await page.close();
}

async function main() {
  const { chromium } = require('playwright');
  const targetPlatform = process.argv[2] || 'all';

  const platforms = targetPlatform === 'all'
    ? Object.keys(PLATFORM_URLS)
    : [targetPlatform];

  for (const p of platforms) {
    if (!PLATFORM_URLS[p]) {
      console.error(`Unknown platform: ${p}. Valid: ${Object.keys(PLATFORM_URLS).join(', ')}`);
      process.exit(1);
    }
  }

  console.log('[save-session] Launching Chrome Profile 4 (DossieBot)...');
  console.log('[save-session] NOTE: Chrome must be fully closed before running this.');

  const context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
    headless: false,
    channel: 'chrome',
    args: [
      '--no-sandbox',
      `--profile-directory=${PROFILE_NAME}`,
    ],
    viewport: { width: 1280, height: 900 },
  });

  try {
    for (const platform of platforms) {
      await savePlatformSession(context, platform, PLATFORM_URLS[platform]);
    }
  } finally {
    await context.close();
  }

  console.log('\n[save-session] Done. Session files saved to scripts/sessions/');
  console.log('[save-session] Scanners will now use these cookies. Chrome can stay open.');
}

main().catch(err => {
  console.error('[save-session] Error:', err.message);
  console.error('\nMake sure Chrome is fully closed before running this script.');
  process.exit(1);
});
