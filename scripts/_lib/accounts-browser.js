'use strict';

// scripts/_lib/accounts-browser.js
//
// Shared launcher for Heath's personal "Accounts" persona — financial and
// service logins he wants Cole able to operate directly (RBFCU, Toyota
// Financial, Allstate, USAA, and similar). Gives Accounts its own dedicated,
// persistent Chrome profile so it NEVER collides with:
//   - ~/.brokerage-browser-profile (Brokerage persona — connectMLS/zipForm,
//     see ./brokerage-browser.js)
//   - .brokerage-command-profile (Brokerage CDP-attach / command flows)
//   - the DossieBot-Sage profile (AppData\Local\DossieBot-Sage — Facebook/
//     Instagram/LinkedIn marketing automation)
//   - the shared MCP `playwright` server's profile
//     (C:\Users\Heath\.jarvis-browser-profile, config in .mcp.json) that
//     Quinn and every mcp__playwright__* tool call drives
// Every one of those profiles is a SEPARATE Chrome user-data-dir on disk —
// this module adds one more, it does not reuse or branch off any of them.
//
// Pattern copied directly from ./brokerage-browser.js (same
// launchPersistentContext + WSL re-exec + cooperative-lock approach) — do
// not reinvent this. Differences from brokerage-browser.js are called out
// inline below; everything else is intentionally identical.
//
// Usage (from any Accounts one-off script):
//   const { launchAccountsContext, ACCOUNTS_PROFILE_DIR } = require('./_lib/accounts-browser');
//   const context = await launchAccountsContext({ headless: true, reason: 'my-task' });
//   const page = await context.newPage();
//   await page.goto('https://rbfcu.org');
//   ...
//   await context.close();   // ALWAYS close when done — see PLAYWRIGHT-SETUP.md
//
// headless defaults to true. Pass headless:false only for the one-time
// interactive login pass (see scripts/accounts-login.js) or for debugging a
// selector with Heath watching.
//
// === storageState is FORBIDDEN here — do not add it ===
// brokerage-browser.js tried wiring a saved storageState snapshot in as the
// default on 2026-09-10 and reverted it the same day: launchPersistentContext
// -> setStorageState() is additive/overwrite-by-(name,domain,path) against
// the SAME live profile, not a full cookie-jar replace. Loading an old
// snapshot overwrote live, currently-valid session cookies with stale ones
// and broke an already-authenticated session. That failure mode applies
// here just as much — a stale snapshot for a banking site could silently
// invalidate a live, already-signed-in session. This module exposes NO
// storageState option at all (not even opt-in) — the persistent profile
// directory IS the only session-persistence mechanism. See
// brokerage-browser.js's header comment for the full root-cause writeup.
//
// === one profile, one holder at a time ===
// Only one Playwright context may hold ACCOUNTS_PROFILE_DIR at a time —
// Chrome's ProcessSingleton lock enforces this, and launchAccountsContext()
// waits cooperatively (via the same unlockProfile() helper brokerage-browser
// uses) rather than killing a live holder. Never pass forceUnlock unless you
// are deliberately reclaiming the profile from a job you know is dead —
// killing a live holder can drop Heath's own interactive login window
// mid-session (see chrome-profile-unlock.js header for the 2026-08-30
// incident this guards against).
//
// === no secrets in this file or in any caller ===
// This module launches a browser and returns a context — it never reads,
// stores, types, or logs a password, PIN, security-question answer, or
// one-time code. Credential entry is always done by Heath's own hands in
// the headful window scripts/accounts-login.js opens. This is a PUBLIC
// repo — nothing here may ever carry a literal secret.

const path = require('path');
const os = require('os');
const fs = require('fs');

// === WSL guard — copied from brokerage-browser.js, see its header for the
// full incident writeup (2026-09-14). Real Chrome only exists on the
// Windows side of this box:
//   1. `channel: 'chrome'` resolves to a Linux Chrome path
//      (/opt/google/chrome/chrome) that doesn't exist under WSL — this is
//      the exact failure the shared MCP playwright server hits
//      ("Chromium distribution 'chrome' is not found at
//      /opt/google/chrome/chrome").
//   2. os.homedir() under WSL node resolves to /home/heath, NOT the real
//      Windows profile location — so even papering over #1 would silently
//      write into a throwaway Linux directory.
// Financial sites run aggressive bot/fraud detection (worse than most
// marketing targets this repo automates against) — real Chrome via
// `channel: 'chrome'` is materially less fingerprintable than Playwright's
// bundled Chromium, so this module deliberately does NOT fall back to
// bundled Chromium under WSL. Instead it re-execs the calling script through
// the real Windows node.exe, exactly like brokerage-browser.js, so
// `channel: 'chrome'` and os.homedir() both resolve correctly. Verified
// working 2026-10-01 — see PLAYWRIGHT-SETUP.md "Accounts browser profile"
// section for the actual command output.
function isWSL() {
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function toWindowsPath(p) {
  const m = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(p);
  if (!m) return p;
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
}

const WINDOWS_NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe';

if (isWSL() && !process.env.ACCOUNTS_BROWSER_REEXECD) {
  const scriptPath = process.argv[1];
  const manualCmd = scriptPath
    ? `"${WINDOWS_NODE_EXE}" "${toWindowsPath(path.resolve(scriptPath))}" ${process.argv.slice(2).join(' ')}`.trim()
    : `run this from a Windows shell instead of WSL (node.exe at "${WINDOWS_NODE_EXE}")`;

  if (!scriptPath) {
    throw new Error(
      '[accounts-browser] running under WSL with no resolvable entry script (process.argv[1] missing) — ' +
      'cannot re-exec through Windows node.exe. Real Chrome does not exist under WSL. ' +
      `Run this script from Windows node instead: ${manualCmd}`
    );
  }

  try {
    const { spawnSync } = require('child_process');
    const winScript = toWindowsPath(path.resolve(scriptPath));
    const winArgs = process.argv.slice(2);
    const tmpDir = '/mnt/c/Users/Heath/AppData/Local/Temp';
    const batPathWsl = path.join(tmpDir, `accounts-reexec-${process.pid}.bat`);
    const batPathWin = toWindowsPath(batPathWsl);
    const quoted = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const batContents = [
      '@echo off',
      `"${WINDOWS_NODE_EXE}" ${quoted(winScript)} ${winArgs.map(quoted).join(' ')}`,
      '',
    ].join('\r\n');
    fs.writeFileSync(batPathWsl, batContents, 'utf8');

    console.error(`[accounts-browser] WSL detected — real Chrome only exists on Windows. Re-launching ${path.basename(scriptPath)} through Windows node.exe...`);

    const result = require('child_process').spawnSync('cmd.exe', ['/c', batPathWin], {
      stdio: 'inherit',
      env: { ...process.env, ACCOUNTS_BROWSER_REEXECD: '1' },
    });

    try { fs.unlinkSync(batPathWsl); } catch {}

    if (result.error) {
      throw result.error;
    }
    process.exit(result.status == null ? 1 : result.status);
  } catch (e) {
    throw new Error(
      `[accounts-browser] running under WSL and auto re-exec through Windows node.exe FAILED (${e && e.message || e}). ` +
      `Real Chrome does not exist under WSL — this cannot proceed silently. ` +
      `Run this manually instead: ${manualCmd}`
    );
  }
}

const { unlockProfile } = require('./chrome-profile-unlock');

const ACCOUNTS_PROFILE_DIR = process.env.ACCOUNTS_PROFILE_DIR
  || path.join(os.homedir(), '.accounts-browser-profile');

/**
 * Launch the dedicated Accounts Chrome profile (Heath's personal
 * financial/service logins — RBFCU, Toyota Financial, Allstate, USAA, etc).
 * @param {object} opts
 * @param {boolean} [opts.headless=true]
 * @param {string}  [opts.reason='accounts']  tag for the chrome-unlock log
 * @param {{width:number,height:number}} [opts.viewport]
 * @param {number}  [opts.unlockTimeoutMs]  cooperative-wait budget passed to
 *   unlockProfile() before it gives up and throws (default 90000).
 * @param {boolean} [opts.forceUnlock=false]  pass-through to
 *   unlockProfile({ force: true }) — kills a live holder instead of waiting.
 *   Only use this when deliberately reclaiming the profile from a job you
 *   know is dead; nothing in this repo sets it by default.
 * @param {object}  [opts.contextOptions]  extra options merged into
 *   launchPersistentContext()'s options object (advanced use). storageState
 *   is deliberately not accepted here — see header comment.
 * @returns {Promise<import('playwright').BrowserContext>}
 */
async function launchAccountsContext(opts = {}) {
  const headless = opts.headless === false ? false : true;
  const reason = opts.reason || 'accounts';
  const viewport = opts.viewport || { width: 1400, height: 950 };

  // Cooperative preflight: wait for any live chrome.exe holding this
  // profile's lock to release it, clearing stale crash artifacts once it's
  // free. Does NOT kill a live holder unless forceUnlock is explicitly set.
  await unlockProfile({
    profileDir: ACCOUNTS_PROFILE_DIR,
    reason,
    timeoutMs: opts.unlockTimeoutMs,
    force: !!opts.forceUnlock,
  });

  const args = [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
  ];

  const { chromium } = require('playwright');
  const contextOptions = { ...(opts.contextOptions || {}) };
  delete contextOptions.storageState; // forbidden — see header comment

  const context = await chromium.launchPersistentContext(ACCOUNTS_PROFILE_DIR, {
    headless,
    channel: 'chrome',
    viewport,
    args,
    ...contextOptions,
  });
  return context;
}

module.exports = { ACCOUNTS_PROFILE_DIR, launchAccountsContext };
