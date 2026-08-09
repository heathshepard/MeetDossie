'use strict';

// scripts/_lib/brokerage-browser.js
//
// Shared launcher for Heath's Brokerage persona (personal RE practice —
// connectMLS/SABOR, zipForm Transactions Edition). Gives Brokerage its own
// dedicated, persistent Chrome profile so it never collides with:
//   - the shared MCP `playwright` server (headless, profile
//     C:\Users\Heath\.jarvis-browser-profile, config in .mcp.json) that
//     Quinn and everything else's mcp__playwright__* tools drive, and
//   - any other agent's concurrent browser work.
//
// Pattern copied from scripts/extract-cookies-from-profile.js and
// scripts/atlas-dossiebot-fb-login.js (separate launchPersistentContext
// instances, one profile dir per isolated workflow) — do not reinvent this.
//
// Usage (from any Brokerage one-off script):
//   const { launchBrokerageContext, BROKERAGE_PROFILE_DIR } = require('./_lib/brokerage-browser');
//   const context = await launchBrokerageContext({ headless: true, reason: 'my-task' });
//   const page = await context.newPage();
//   await page.goto('https://sabor.connectmls.com/mls.jsp');
//   ...
//   await context.close();   // ALWAYS close when done — see PLAYWRIGHT-SETUP.md
//
// For the actual connectMLS workflow (sign-in check, SmartBar search, result
// read) — use scripts/_lib/connectmls-actions.js (ensureSignedIn,
// smartBarSearch) instead of hand-rolling waitForTimeout() sleeps. That
// module replaced ~dozens of copy-pasted fixed-sleep sequences (2500ms /
// 4000ms / 1200ms / 3500ms per script, every run) with real condition waits.
// See its header comment for the connectMLS SSO-expiry edge case it handles.
//
// headless defaults to true for normal automated runs. Pass headless:false
// only when Heath needs to see/interact with the window himself (e.g. the
// one-time login pass, or debugging a selector).

const path = require('path');
const os = require('os');
const { unlockProfile } = require('./chrome-profile-unlock');

const BROKERAGE_PROFILE_DIR = process.env.BROKERAGE_PROFILE_DIR
  || path.join(os.homedir(), '.brokerage-browser-profile');

/**
 * Launch (or attach to) the dedicated Brokerage Chrome profile.
 * @param {object} opts
 * @param {boolean} [opts.headless=true]
 * @param {string}  [opts.reason='brokerage']  tag for the chrome-unlock log
 * @param {{width:number,height:number}} [opts.viewport]
 * @returns {Promise<import('playwright').BrowserContext>}
 */
async function launchBrokerageContext(opts = {}) {
  const headless = opts.headless === false ? false : true;
  const reason = opts.reason || 'brokerage';
  const viewport = opts.viewport || { width: 1400, height: 950 };

  // Kill any stale chrome.exe still holding this profile's lock (dead script,
  // Ctrl+C, crash) before we try to launch — same guard FB automation uses.
  await unlockProfile({ profileDir: BROKERAGE_PROFILE_DIR, reason });

  const { chromium } = require('playwright');
  const context = await chromium.launchPersistentContext(BROKERAGE_PROFILE_DIR, {
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

module.exports = { BROKERAGE_PROFILE_DIR, launchBrokerageContext };
