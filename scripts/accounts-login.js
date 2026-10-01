#!/usr/bin/env node
'use strict';

// scripts/accounts-login.js
//
// One-time interactive login helper for the Accounts browser profile (see
// scripts/_lib/accounts-browser.js). Opens a real, HEADFUL Chrome window in
// the dedicated ~/.accounts-browser-profile, navigates to the requested
// site, and waits for Heath to log in BY HAND (including any 2FA/MFA step).
// Nothing here reads, stores, types, or transmits a credential — this
// script only drives navigation and the open/close of the window. This is a
// PUBLIC repo; no secret may ever be typed, pasted, or logged by this file.
//
// Usage:
//   node scripts/accounts-login.js <url-or-site-key>
//
//   node scripts/accounts-login.js rbfcu
//   node scripts/accounts-login.js toyota
//   node scripts/accounts-login.js allstate
//   node scripts/accounts-login.js usaa
//   node scripts/accounts-login.js https://example.com/login
//
// Known site keys map to a login/home URL below. Anything else is treated
// as a literal URL (https:// is prepended if missing).
//
// Flow:
//   1. Launches the Accounts profile HEADFUL (Heath will see a real Chrome
//      window — on Windows if run from WSL, via accounts-browser.js's
//      re-exec).
//   2. Navigates to the site.
//   3. Prints instructions and waits for Enter on THIS terminal.
//   4. Heath logs in manually in the browser window (password, 2FA, "trust
//      this device", etc — all by hand).
//   5. Heath presses Enter back in the terminal once logged in.
//   6. The script closes the context cleanly so the session persists to
//      disk in the profile directory for later headless use (e.g.
//      scripts/accounts-session-check.js or any other Accounts script).
//
// Closing cleanly matters — see PLAYWRIGHT-SETUP.md: Chrome locks a
// persistent profile while open, and an unclosed context left running will
// block the next script (or this one, next time) from launching.

const readline = require('readline');
const { launchAccountsContext, ACCOUNTS_PROFILE_DIR } = require('./_lib/accounts-browser');

const SITES = {
  rbfcu: 'https://www.rbfcu.org',
  toyota: 'https://www.toyotafinancial.com',
  allstate: 'https://www.allstate.com',
  usaa: 'https://www.usaa.com',
};

function resolveTarget(arg) {
  const key = String(arg || '').trim().toLowerCase();
  if (SITES[key]) return { key, url: SITES[key] };
  // Unknown key — treat as a URL.
  const url = /^https?:\/\//i.test(arg) ? arg : `https://${arg}`;
  return { key: arg, url };
}

function waitForEnter(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node scripts/accounts-login.js <url-or-site-key>');
    console.error(`Known site keys: ${Object.keys(SITES).join(', ')}`);
    process.exit(1);
  }

  const { key, url } = resolveTarget(arg);

  console.log('');
  console.log('ACCOUNTS LOGIN — one-time interactive sign-in');
  console.log('-'.repeat(60));
  console.log(`Site:    ${key}`);
  console.log(`URL:     ${url}`);
  console.log(`Profile: ${ACCOUNTS_PROFILE_DIR}`);
  console.log('-'.repeat(60));
  console.log('Opening a real Chrome window now. DO NOT close it yourself —');
  console.log('this script closes it for you once you confirm below.');
  console.log('');

  const context = await launchAccountsContext({ headless: false, reason: `accounts-login:${key}` });
  let page;
  try {
    page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.error(`[accounts-login] navigation to ${url} failed: ${e.message}`);
    console.error('The window is still open — you can navigate manually if the site redirected oddly.');
  }

  console.log('Log in by hand in that window now — password, 2FA/OTP, "trust');
  console.log('this device", everything. This script never sees or stores');
  console.log('any of it.');
  console.log('');
  await waitForEnter('Once you are fully signed in, press Enter here to save the session and close the window... ');

  console.log('Closing browser — session persists in the Accounts profile for headless reuse.');
  await context.close();
  console.log('Done.');
}

main().catch((e) => {
  console.error('[accounts-login] fatal:', (e && e.stack) || e);
  process.exit(1);
});
