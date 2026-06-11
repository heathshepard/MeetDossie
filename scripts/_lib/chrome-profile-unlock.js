'use strict';

// scripts/_lib/chrome-profile-unlock.js
//
// Shared helper: kill any stale Chrome processes that are still holding a
// lock on a specific user-data-dir (Chrome profile directory). Used as a
// pre-flight step for ALL Facebook automation that drives Heath's DossieBot
// profile via Playwright's launchPersistentContext.
//
// Why this exists:
//   When a Playwright `launchPersistentContext` run dies abnormally (Node
//   crash, parent process killed, BSOD, manual Ctrl+C in the wrong window),
//   the Chrome child process can be left running attached to the user-data-
//   dir. The next run that tries to `launchPersistentContext` against the
//   same directory crashes with one of:
//     - "ProcessSingleton: failed to acquire lock"
//     - "browserType.launchPersistentContext: Target page, context or browser has been closed"
//     - silent timeout while Chrome refuses to start.
//   Sage flagged 2 of 7 group post failures today (2026-06-11) traced to
//   this. The existing fb-group-watcher's `cleanupZombieChrome` only matches
//   `--headless` / `Playwright` / `.cache\ms-playwright` in the command line
//   and does NOT catch persistent-context Chrome (launched with `channel:
//   'chrome'` against a real user-data-dir). This helper fills that gap by
//   matching the user-data-dir explicitly.
//
// Strategy:
//   1. Enumerate every chrome.exe via WMI Win32_Process (gets full
//      CommandLine — Get-Process does NOT expose it).
//   2. Match CommandLine substring against the resolved DossieBot profile
//      path (case-insensitive; also accepts forward-slash form).
//   3. Stop-Process -Force any matches. Do nothing else.
//   4. Sleep 2000ms so the kernel releases the Singleton* file handles
//      before the caller tries launchPersistentContext.
//   5. Append every action to scripts/atlas-runs/chrome-unlock-YYYY-MM-DD.log
//      (matches the fb-tab-preflight log naming convention).
//
// Usage from any FB script:
//   const { unlockProfile } = require('./_lib/chrome-profile-unlock');
//   await unlockProfile({ profileDir: CHROME_PROFILE_PATH, reason: 'fb-group-poster' });
//
// Safe to call multiple times — idempotent. Safe when no stale Chrome is
// running — returns { killed: 0 } and logs a no-op line.
//
// IMPORTANT — what this does NOT do:
//   - Does NOT touch Heath's main Chrome (different user-data-dir).
//   - Does NOT close FB tabs — that's the job of fb-tab-preflight.js.
//   - Does NOT validate session state, log in, or navigate anywhere.

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUN_DIR = path.join(REPO_ROOT, 'scripts', 'atlas-runs');
if (!fs.existsSync(RUN_DIR)) {
  try { fs.mkdirSync(RUN_DIR, { recursive: true }); } catch {}
}

function logLine(reason, line) {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const logPath = path.join(RUN_DIR, `chrome-unlock-${date}.log`);
    const ts = new Date().toISOString();
    fs.appendFileSync(logPath, `[${ts}] [${reason || 'unspecified'}] ${line}\n`);
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Kill all chrome.exe processes whose command line references the given
 * user-data-dir, then wait for file handles to release.
 *
 * @param {object} opts
 * @param {string} opts.profileDir  Absolute path to the Chrome user-data-dir.
 * @param {string} [opts.reason]    Short tag for log lines (e.g. 'fb-group-poster').
 * @param {number} [opts.waitMs=2000]  Sleep after killing, default 2000ms.
 * @param {boolean} [opts.dryRun=false]  If true, log matches but do not kill.
 * @returns {Promise<{killed: number, matched: string[], errors: string[]}>}
 */
async function unlockProfile(opts = {}) {
  const profileDir = opts.profileDir;
  const reason = opts.reason || 'chrome-unlock';
  const waitMs = typeof opts.waitMs === 'number' ? opts.waitMs : 2000;
  const dryRun = !!opts.dryRun;

  const result = { killed: 0, matched: [], errors: [] };

  if (!profileDir || typeof profileDir !== 'string') {
    logLine(reason, 'ERROR: profileDir is required');
    result.errors.push('profileDir-required');
    return result;
  }

  const normalized = path.resolve(profileDir);
  logLine(reason, `start dryRun=${dryRun} profileDir=${normalized}`);

  // Build a PowerShell script that:
  //  1. Queries Win32_Process for chrome.exe
  //  2. Filters CommandLine on a case-insensitive substring match of the
  //     profile dir (or its forward-slash equivalent)
  //  3. Stops each match (or only lists when -DryRun)
  //  4. Emits machine-readable lines: KILL <pid> <commandline-trimmed>
  //
  // We escape the profile path for inclusion in a PowerShell single-quoted
  // string (double up single quotes).
  const psEscaped = normalized.replace(/'/g, "''");
  const psEscapedFwd = normalized.replace(/\\/g, '/').replace(/'/g, "''");
  const killClause = dryRun
    ? "Write-Output (\"DRYRUN \" + $_.ProcessId + ' ' + ($_.CommandLine -replace '\\s+',' '))"
    : "try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Output (\"KILL \" + $_.ProcessId + ' ' + ($_.CommandLine -replace '\\s+',' ')) } catch { Write-Output (\"ERR \" + $_.ProcessId + ' ' + $_.Exception.Message) }";

  const psScript = [
    "$ErrorActionPreference = 'SilentlyContinue';",
    "$needle1 = '" + psEscaped + "';",
    "$needle2 = '" + psEscapedFwd + "';",
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ",
    "Where-Object { $_.CommandLine -and ( ($_.CommandLine -like ('*' + $needle1 + '*')) -or ($_.CommandLine -like ('*' + $needle2 + '*')) ) } | ",
    "ForEach-Object { " + killClause + " }",
  ].join('');

  let out = '';
  try {
    out = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/"/g, '\\"')}"`,
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 15000 }
    );
  } catch (e) {
    const msg = (e && (e.stderr ? e.stderr.toString() : e.message)) || 'unknown';
    logLine(reason, `powershell error: ${msg.trim().slice(0, 400)}`);
    result.errors.push('powershell-error');
    return result;
  }

  const lines = (out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('KILL ')) {
      result.killed += 1;
      result.matched.push(line.slice(5));
      logLine(reason, line);
    } else if (line.startsWith('DRYRUN ')) {
      result.matched.push(line.slice(7));
      logLine(reason, line);
    } else if (line.startsWith('ERR ')) {
      result.errors.push(line.slice(4));
      logLine(reason, line);
    }
  }

  if (result.killed === 0 && result.matched.length === 0) {
    logLine(reason, 'no stale chrome processes found');
  }

  // Always sleep — even on zero kills the previous process may have just
  // exited and the Singleton lockfiles may not be released yet. 2 s is the
  // Chromium-empirical settle window.
  if (waitMs > 0) {
    logLine(reason, `sleep ${waitMs}ms for handle release`);
    await sleep(waitMs);
  }

  logLine(reason, `end killed=${result.killed} matched=${result.matched.length} errors=${result.errors.length}`);
  return result;
}

module.exports = { unlockProfile };

// Allow direct CLI invocation:
//   node scripts/_lib/chrome-profile-unlock.js <profile-dir> [reason] [--dry-run]
if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const dryRun = argv.includes('--dry-run');
    const positional = argv.filter((a) => !a.startsWith('--'));
    const profileDir = positional[0];
    const reason = positional[1] || 'cli';
    if (!profileDir) {
      console.error('Usage: node scripts/_lib/chrome-profile-unlock.js <profile-dir> [reason] [--dry-run]');
      process.exit(2);
    }
    const r = await unlockProfile({ profileDir, reason, dryRun });
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  })();
}
