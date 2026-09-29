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
//
// === zipForm session persistence (added, then REVERTED as default, 2026-09-10) ===
// A same-day change wired scripts/_lib/zipform-session.js in as the DEFAULT
// here via Playwright's `storageState` option, on the theory it would
// hydrate a saved zipformplus.com session before launch. It didn't restore
// zipForm (confirmed: password field still shown after load) and it broke
// connectMLS auth as a side effect (confirmed: session that was previously
// authenticated started redirecting to login.jsp).
//
// Root cause, confirmed by reading Playwright's source
// (launchPersistentContext -> setStorageState(mode: "initial") ->
// addCookies(state.cookies) -> CDP `Playwright.setCookies`): this call is
// additive/overwrite-by-(name,domain,path), not a full cookie-jar replace,
// against the SAME persistent profile the connectMLS session already lives
// in. The saved snapshot (scripts/_lib/zipform-session.js's
// C:\Users\Heath\.zipform-session-state.json) is a whole-browsing-session
// capture — it includes stale cookies for lera.connectmls.com and
// sabor.mysolidearth.com (visitorid, usertype, etc.) from whenever it was
// last saved. Loading it overwrites the persistent profile's live,
// currently-valid connectMLS cookies with those stale ones, which is enough
// to invalidate the server-side session -> login.jsp. Meanwhile the
// zipForm-specific payload in that same snapshot has 0 captured
// localStorage/sessionStorage origins and only session-lifetime cookies
// (`token`, `ASP.NET_SessionId`) — which did not restore an authenticated
// zipForm session even ~1 hour after being saved.
//
// So: DO NOT wire zipform-session.js in here by default. It is opt-in only
// via { hydrateZipFormSession: true }, and given the above, opting in is
// NOT currently recommended for anything that also needs connectMLS in the
// same profile. See the CDP-attach pattern below for the approach that
// actually works for zipForm within a single working session.
//
// === CDP attach mode (added 2026-09-10) ===
// Pass { remoteDebuggingPort: N } to launch with
// --remote-debugging-port=N, which lets separate short-lived scripts attach
// via chromium.connectOverCDP('http://127.0.0.1:N') and drive the SAME
// still-open browser without ever closing it — closing/reopening is what
// drops zipForm's session. Use this pattern for any multi-step interactive
// flow (e.g. sending an e-sign packet) instead of one long blind script or
// a close-and-relaunch loop. See scripts/brokerage-nopalito-holder.js +
// scripts/brokerage-nopalito-cdp-*.js for the reference implementation.

const path = require('path');
const os = require('os');
const fs = require('fs');

// === WSL guard (added 2026-09-14) ===
// Real Chrome only exists on the Windows side of this box. Two things broke
// silently when a script requiring this module was run from a WSL bash shell
// (`node scripts/brokerage-login-setup.js`), confirmed live 2026-09-14 after
// Heath got a blank window twice:
//   1. `channel: 'chrome'` resolves to a Linux Chrome path
//      (/opt/google/chrome/chrome) that doesn't exist under WSL, so
//      launchPersistentContext throws "Chromium distribution 'chrome' is not
//      found" — but callers that don't surface that error just look dead.
//   2. Even if that were papered over, os.homedir() under WSL node resolves
//      to /home/heath, NOT the real profile at
//      C:\Users\Heath\.brokerage-browser-profile — so it would write into a
//      throwaway Linux directory with none of the saved connectMLS/zipForm
//      login state, silently.
//
// Fix: detect WSL at require()-time (before any caller does other work) and
// transparently re-exec the CALLING script through the real Windows
// node.exe, translating /mnt/c/... argv[1]/args to C:\... and inheriting
// stdio so output looks identical to a native run. This mirrors the proven
// bat-file-wrapper pattern in scripts/win-launch.sh (nested cmd.exe quoting
// silently mangles paths — write a temp .bat, run that instead) and the
// gbp holder.js/attach.js precedent for driving real Windows Chrome from a
// WSL agent session. If the re-exec itself can't be set up for any reason,
// this throws a loud, explicit error with the exact command to run manually
// — it never falls through to a silent no-op launch.
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

if (isWSL() && !process.env.BROKERAGE_BROWSER_REEXECD) {
  const scriptPath = process.argv[1];
  const manualCmd = scriptPath
    ? `scripts/win-launch.sh "${WINDOWS_NODE_EXE}" "${toWindowsPath(path.resolve(scriptPath))}" ${process.argv.slice(2).join(' ')}`.trim()
    : `run this from a Windows shell instead of WSL (node.exe at "${WINDOWS_NODE_EXE}")`;

  if (!scriptPath) {
    throw new Error(
      '[brokerage-browser] running under WSL with no resolvable entry script (process.argv[1] missing) — ' +
      'cannot re-exec through Windows node.exe. Real Chrome does not exist under WSL. ' +
      `Run this script from Windows node instead: ${manualCmd}`
    );
  }

  try {
    const { spawnSync } = require('child_process');
    const winScript = toWindowsPath(path.resolve(scriptPath));
    const winArgs = process.argv.slice(2);
    const tmpDir = '/mnt/c/Users/Heath/AppData/Local/Temp';
    const batPathWsl = path.join(tmpDir, `brokerage-reexec-${process.pid}.bat`);
    const batPathWin = toWindowsPath(batPathWsl);
    const quoted = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const batContents = [
      '@echo off',
      `"${WINDOWS_NODE_EXE}" ${quoted(winScript)} ${winArgs.map(quoted).join(' ')}`,
      '',
    ].join('\r\n');
    fs.writeFileSync(batPathWsl, batContents, 'utf8');

    console.error(`[brokerage-browser] WSL detected — real Chrome only exists on Windows. Re-launching ${path.basename(scriptPath)} through Windows node.exe...`);

    const result = require('child_process').spawnSync('cmd.exe', ['/c', batPathWin], {
      stdio: 'inherit',
      env: { ...process.env, BROKERAGE_BROWSER_REEXECD: '1' },
    });

    try { fs.unlinkSync(batPathWsl); } catch {}

    if (result.error) {
      throw result.error;
    }
    process.exit(result.status == null ? 1 : result.status);
  } catch (e) {
    throw new Error(
      `[brokerage-browser] running under WSL and auto re-exec through Windows node.exe FAILED (${e && e.message || e}). ` +
      `Real Chrome does not exist under WSL — this cannot proceed silently. ` +
      `Run this manually instead: ${manualCmd}`
    );
  }
}

const { unlockProfile } = require('./chrome-profile-unlock');
const { loadZipFormSessionOptions } = require('./zipform-session');

const BROKERAGE_PROFILE_DIR = process.env.BROKERAGE_PROFILE_DIR
  || path.join(os.homedir(), '.brokerage-browser-profile');

/**
 * Launch (or attach to) the dedicated Brokerage Chrome profile.
 * @param {object} opts
 * @param {boolean} [opts.headless=true]
 * @param {string}  [opts.reason='brokerage']  tag for the chrome-unlock log
 * @param {{width:number,height:number}} [opts.viewport]
 * @param {number}  [opts.unlockTimeoutMs]  cooperative-wait budget passed to
 *   unlockProfile() before it gives up and throws (default 90000). Bump this
 *   for scripts that expect to queue behind a long-running job.
 * @param {boolean} [opts.forceUnlock=false]  pass-through to
 *   unlockProfile({ force: true }) — kills a live holder instead of waiting.
 *   Only use this when deliberately reclaiming the profile from a job you
 *   know is dead; nothing in this repo sets it by default.
 * @param {boolean} [opts.hydrateZipFormSession=false]  OPT-IN ONLY. Load a
 *   saved zipformplus.com session (cookies+storage) into the context if one
 *   exists on disk. Reverted from default-on 2026-09-10 — see the header
 *   comment above: it didn't restore zipForm and it broke connectMLS auth
 *   in the same profile by overwriting live cookies with a stale snapshot.
 * @param {number}  [opts.remoteDebuggingPort]  if set, launches Chrome with
 *   --remote-debugging-port=<port> so other scripts can
 *   chromium.connectOverCDP() into this same running browser instead of
 *   launching a competing/conflicting persistent context.
 * @param {object}  [opts.contextOptions]  extra options merged into
 *   launchPersistentContext()'s options object (advanced use).
 * @returns {Promise<import('playwright').BrowserContext>}
 */
async function launchBrokerageContext(opts = {}) {
  const headless = opts.headless === false ? false : true;
  const reason = opts.reason || 'brokerage';
  const viewport = opts.viewport || { width: 1400, height: 950 };
  const hydrateZipFormSession = opts.hydrateZipFormSession === true;

  // Cooperative preflight: wait for any live chrome.exe holding this
  // profile's lock to release it, clearing stale crash artifacts once it's
  // free. Does NOT kill a live holder unless forceUnlock is explicitly set —
  // see scripts/_lib/chrome-profile-unlock.js header for why (this profile
  // is shared across many concurrent agent jobs; the old kill-on-sight
  // default dropped Heath's own connectMLS login window mid-session,
  // 2026-08-30).
  await unlockProfile({
    profileDir: BROKERAGE_PROFILE_DIR,
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
  if (opts.remoteDebuggingPort) {
    args.push(`--remote-debugging-port=${opts.remoteDebuggingPort}`);
  }

  const sessionOptions = hydrateZipFormSession ? loadZipFormSessionOptions() : {};

  const { chromium } = require('playwright');
  const context = await chromium.launchPersistentContext(BROKERAGE_PROFILE_DIR, {
    headless,
    channel: 'chrome',
    viewport,
    args,
    ...sessionOptions,
    ...(opts.contextOptions || {}),
  });
  return context;
}

module.exports = { BROKERAGE_PROFILE_DIR, launchBrokerageContext };
