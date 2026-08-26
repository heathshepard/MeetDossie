'use strict';

// scripts/_lib/rust-playconsole-browser.js
//
// Dedicated, persistent Chrome profile for Google Play Console automation
// against the Rust fitness app (developer account 6719074801771127302, app
// 4972720077147610907). Same pattern as scripts/_lib/brokerage-browser.js
// (connectMLS/zipForm) and scripts/_lib/quinn-browser.js (Jarvis QA) —
// launchPersistentContext against a stable on-disk user-data-dir, NOT an
// exported storageState JSON file.
//
// Why profile-dir (not storageState.json): confirmed 2026-08-25 this is the
// established, working convention for every "log in once by hand, reuse
// forever" workflow in this repo (connectMLS has no MFA and is pure session-
// cookie; Quinn/Brokerage both use this exact shape). A profile dir persists
// cookies AND localStorage AND IndexedDB AND the Chrome device fingerprint
// itself — for Google specifically, that last part matters: Google's login-
// risk model partly keys off a consistent browser/device fingerprint, so
// reusing the SAME real Chrome profile every run (not just replaying
// cookies into a fresh throwaway context) is more likely to avoid tripping
// a "new device / verify it's you" re-auth than a bare storageState.json
// would be. See rust-playconsole-login-setup.js header for the Google-
// specific caveats (this is NOT as durable as connectMLS's near-permanent
// session).
//
// Usage (from any Rust/Play Console one-off script):
//   const { launchRustPlayConsoleContext, RUST_PLAYCONSOLE_PROFILE_DIR, DEVELOPER_ID, APP_ID, storeListingUrl } = require('./_lib/rust-playconsole-browser');
//   const context = await launchRustPlayConsoleContext({ headless: true, reason: 'my-task' });
//   const page = await context.newPage();
//   await page.goto(storeListingUrl());
//   ...
//   await context.close();   // ALWAYS close when done — an open persistent
//                             // context locks the profile for the next run.

const path = require('path');
const os = require('os');
const { unlockProfile } = require('./chrome-profile-unlock');

const RUST_PLAYCONSOLE_PROFILE_DIR = process.env.RUST_PLAYCONSOLE_PROFILE_DIR
  || path.join(os.homedir(), '.rust-playconsole-browser-profile');

// Play Console identifiers for the Rust app — confirmed by Heath 2026-08-25.
const DEVELOPER_ID = '6719074801771127302';
const APP_ID = '4972720077147610907';

/**
 * Build the Play Console "main store listing" edit URL for the Rust app.
 * Centralized here so every script targets the same URL and a future ID
 * change (new developer account, new app) only needs updating in one place.
 */
function storeListingUrl() {
  return `https://play.google.com/console/u/0/developers/${DEVELOPER_ID}/app/${APP_ID}/main-store-listing`;
}

/**
 * The Play Console app dashboard URL — a lighter-weight landing page than
 * the store-listing editor, useful as a plain "are we authenticated at all"
 * check without touching listing content.
 */
function appDashboardUrl() {
  return `https://play.google.com/console/u/0/developers/${DEVELOPER_ID}/app/${APP_ID}/app-dashboard`;
}

/**
 * Launch (or attach to) the dedicated Rust Play Console Chrome profile.
 * @param {object} opts
 * @param {boolean} [opts.headless=true]
 * @param {string}  [opts.reason='rust-playconsole']  tag for the chrome-unlock log
 * @param {{width:number,height:number}} [opts.viewport]
 * @returns {Promise<import('playwright').BrowserContext>}
 */
async function launchRustPlayConsoleContext(opts = {}) {
  const headless = opts.headless === false ? false : true;
  const reason = opts.reason || 'rust-playconsole';
  const viewport = opts.viewport || { width: 1440, height: 950 };

  // Kill any stale chrome.exe still holding this profile's lock (dead
  // script, Ctrl+C, crash) before we try to launch — same guard Brokerage/
  // Quinn/FB automation all use.
  await unlockProfile({ profileDir: RUST_PLAYCONSOLE_PROFILE_DIR, reason });

  const { chromium } = require('playwright');
  const context = await chromium.launchPersistentContext(RUST_PLAYCONSOLE_PROFILE_DIR, {
    headless,
    channel: 'chrome',
    viewport,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  return context;
}

module.exports = {
  RUST_PLAYCONSOLE_PROFILE_DIR,
  DEVELOPER_ID,
  APP_ID,
  storeListingUrl,
  appDashboardUrl,
  launchRustPlayConsoleContext,
};
