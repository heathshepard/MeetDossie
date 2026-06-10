'use strict';

// scripts/extract-session-via-chrome.js
//
// Extracts Chrome Profile 4 Facebook session by launching Chrome
// against a temp copy of the profile (avoids profile lock).
// Chrome decrypts the v20 cookies natively.
//
// Usage: node scripts/extract-session-via-chrome.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const SESSION_FILE = path.join(__dirname, 'sessions', 'facebook.json');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

const CHROME_USER_DATA = path.join(
  os.homedir(),
  'AppData', 'Local', 'Google', 'Chrome', 'User Data'
);
const PROFILE_4 = path.join(CHROME_USER_DATA, 'Profile 4');
const LOCAL_STATE = path.join(CHROME_USER_DATA, 'Local State');

async function main() {
  const { chromium } = require('playwright');

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  console.log('[extract-session] Creating temp Chrome user data dir...');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dossie-chrome-'));

  try {
    // Copy Local State (contains the encryption key)
    fs.copyFileSync(LOCAL_STATE, path.join(tempDir, 'Local State'));

    // Copy Profile 4 → Default (launchPersistentContext uses Default)
    const destDefault = path.join(tempDir, 'Default');
    console.log('[extract-session] Copying Profile 4 → Default (may take a few seconds)...');
    copyDirSync(PROFILE_4, destDefault);
    console.log('[extract-session] Copy complete.');

    // Launch Chrome using the copied profile
    console.log('[extract-session] Launching Chrome with copied profile...');
    const context = await chromium.launchPersistentContext(tempDir, {
      channel: 'chrome',
      headless: false,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions-except',
        '--disable-popup-blocking',
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
      ],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    console.log('[extract-session] Navigating to Facebook...');
    await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const url = page.url();
    console.log('[extract-session] Current URL:', url);

    if (url.includes('login') || url.includes('checkpoint')) {
      console.error('[extract-session] NOT LOGGED IN — Chrome profile is not authenticated with Facebook.');
      console.error('[extract-session] Run: node scripts/capture-facebook-session.js instead.');
      await context.close();
      return;
    }

    console.log('[extract-session] Logged in! Saving session...');
    await context.storageState({ path: SESSION_FILE });

    const stat = fs.statSync(SESSION_FILE);
    console.log(`[extract-session] Session saved: ${SESSION_FILE} (${stat.size} bytes)`);

    await context.close();
  } finally {
    // Clean up temp dir
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      console.warn('[extract-session] Could not clean up temp dir:', tempDir);
    }
  }

  console.log('[extract-session] Done. Run: node scripts/fb-group-watcher.js');
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    try {
      if (entry.isDirectory()) {
        copyDirSync(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    } catch (e) {
      // Skip locked files (e.g., Chrome's lock files)
    }
  }
}

main().catch(err => {
  console.error('[extract-session] Error:', err.message);
  process.exit(1);
});
