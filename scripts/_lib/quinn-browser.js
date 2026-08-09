'use strict';

// scripts/_lib/quinn-browser.js
//
// Dedicated, persistent Chrome profile for Quinn's real-browser QA work —
// same pattern as scripts/_lib/brokerage-browser.js (built 2026-08-06), but
// solving a different problem:
//
//   Brokerage needed COLLISION isolation from the shared MCP playwright
//   browser (C:\Users\Heath\.jarvis-browser-profile in .mcp.json).
//
//   Quinn needs VIEWPORT CONTROL. Twice on 2026-08-06, Quinn had to borrow
//   Heath's live myjarvis Chrome tab (extracting his real auth JWT out of an
//   already-open window) to sign in, and that shared MCP browser instance
//   was found ATTACHED to Heath's real, physically-snapped Chrome window
//   (929x917, non-resizable) — so Quinn could not actually render or
//   screenshot the new Jarvis layout at a real 1920x1080 desktop width, the
//   exact size the layout fix targeted and the exact size Heath's own
//   screenshots were taken at.
//
// This profile fixes both:
//   1. Own persistent profile dir -> own login, no more per-run JWT
//      extraction out of Heath's live session.
//   2. `launchPersistentContext` spawns a SEPARATE chrome.exe process with
//      its own top-level window sized by Playwright's `viewport` /
//      `--window-size` args — it does NOT attach to or inherit Heath's
//      physical window geometry. Confirmed 2026-08-06 (see
//      scripts/quinn-viewport-check.js output in scripts/atlas-runs/):
//      page.evaluate(() => [innerWidth, innerHeight]) reported the exact
//      requested viewport, and Heath's real Chrome window was untouched
//      (929x917, still snapped) the entire time.
//
// Usage (from any Quinn one-off QA script):
//   const { launchQuinnContext, QUINN_PROFILE_DIR, VIEWPORTS } = require('./_lib/quinn-browser');
//   const context = await launchQuinnContext({ headless: true, viewport: VIEWPORTS.desktop, reason: 'jarvis-layout-qa' });
//   const page = await context.newPage();
//   await page.goto('https://meet-dossie-git-staging-heathshepard-6590s-projects.vercel.app/myjarvis');
//   ...
//   await context.close();   // ALWAYS close when done — an open persistent
//                             // context locks the profile for the next run.

const path = require('path');
const os = require('os');
const { unlockProfile } = require('./chrome-profile-unlock');

const QUINN_PROFILE_DIR = process.env.QUINN_PROFILE_DIR
  || path.join(os.homedir(), '.quinn-browser-profile');

// Named real-world sizes Quinn tests against. Pass a custom {width,height}
// to launchQuinnContext({ viewport }) for anything not listed here.
const VIEWPORTS = {
  desktop: { width: 1920, height: 1080 }, // the size the Jarvis layout fix targets, and what Heath's own screenshots are taken at
  laptop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1194 },
  mobile: { width: 390, height: 844 },
};

/**
 * Launch (or attach to) the dedicated Quinn QA Chrome profile.
 * @param {object} opts
 * @param {boolean} [opts.headless=true]
 * @param {string}  [opts.reason='quinn-qa']  tag for the chrome-unlock log
 * @param {{width:number,height:number}} [opts.viewport]  defaults to VIEWPORTS.desktop (1920x1080)
 * @returns {Promise<import('playwright').BrowserContext>}
 */
async function launchQuinnContext(opts = {}) {
  const headless = opts.headless === false ? false : true;
  const reason = opts.reason || 'quinn-qa';
  const viewport = opts.viewport || VIEWPORTS.desktop;

  // Kill any stale chrome.exe still holding this profile's lock (dead
  // script, Ctrl+C, crash) before we try to launch — same guard Brokerage
  // and FB automation use.
  await unlockProfile({ profileDir: QUINN_PROFILE_DIR, reason });

  const { chromium } = require('playwright');
  const context = await chromium.launchPersistentContext(QUINN_PROFILE_DIR, {
    headless,
    channel: 'chrome',
    viewport,
    // --window-size/--window-position pin the OS-level window itself (not
    // just the page viewport) so a headed run also opens at the requested
    // size regardless of where Heath's own windows are positioned.
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${viewport.width},${viewport.height}`,
      '--window-position=0,0',
    ],
  });
  return context;
}

module.exports = { QUINN_PROFILE_DIR, VIEWPORTS, launchQuinnContext };
