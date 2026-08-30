'use strict';

// scripts/_lib/chrome-profile-unlock.js
//
// Shared helper: make a Chrome user-data-dir (profile directory) safe to
// launch against via Playwright's launchPersistentContext.
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
// === 2026-08-30 REWRITE — cooperative by default, kill is opt-in ===
//   The original version of this file matched ANY chrome.exe whose
//   CommandLine referenced the profile dir and force-killed it, every time,
//   unconditionally. That's correct for a truly orphaned/crashed process,
//   but the `.brokerage-browser-profile` and `.brokerage-command-profile`
//   directories are shared by MANY concurrent agent jobs (wc-compliance-*,
//   ridgebluff-*, brokerage-*), so this preflight was killing whichever job
//   (or Heath's own interactive headed login window — see
//   scripts/brokerage-mls-open.js) got there first. Root-caused from
//   scripts/atlas-runs/chrome-unlock-2026-08-30.log: 5 separate KILL bursts
//   between 14:26 and 14:44, including two that killed a live
//   `brokerage-mls-open` / passkey-reauth window within ~10-90s of launch —
//   dropping Heath's connectMLS session mid-login, twice, in one afternoon.
//
//   New strategy:
//     1. Detect whether ANY live chrome.exe process currently has the
//        profileDir on its command line ("a holder").
//     2. No holder found: the profile is free. Clear any stale
//        SingletonLock/SingletonCookie/SingletonSocket files left behind by
//        a crash (nothing is running to hold them anymore, so they're
//        artifacts, not real locks) and repair `exit_type: "Crashed"` in
//        Default/Preferences back to "Normal" so Chrome doesn't show a
//        crash-restore prompt. Then proceed immediately.
//     3. A holder IS found: by default, WAIT with backoff (not kill) for the
//        holder to exit on its own, up to `timeoutMs` (default 90s — matches
//        the job cadence observed in production). If it releases in time,
//        proceed exactly as in case 2. If it doesn't, THROW a clear error
//        naming the holding PID and (best-effort, by walking the parent
//        process chain to the owning node script) the script that owns it.
//        Never kill in this path.
//     4. Only `unlockProfile({ ..., force: true })` kills a live holder —
//        and nothing in this repo passes that flag by default. Use it only
//        for a script that is deliberately reclaiming the profile.
//
//   `launchBrokerageContext()` in ./brokerage-browser.js uses this
//   cooperative path (no force). Every other caller — grep shows ~500
//   scripts touch unlockProfile/launchBrokerageContext transitively — gets
//   the same behavior change automatically: they'll simply wait instead of
//   killing. A script that times out and throws will surface a real error
//   instead of silently clobbering another job.
//
// Usage from any script:
//   const { unlockProfile } = require('./_lib/chrome-profile-unlock');
//   await unlockProfile({ profileDir: CHROME_PROFILE_PATH, reason: 'my-job' });
//   // ^ waits cooperatively, clears stale artifacts, throws only if the
//   //   profile is still held after timeoutMs (default 90000).
//
//   // Explicit reclaim (rare — only when you deliberately want to boot
//   // whatever is holding the profile):
//   await unlockProfile({ profileDir: CHROME_PROFILE_PATH, reason: 'my-job', force: true });
//
// Options:
//   profileDir  (required) absolute path to the Chrome user-data-dir.
//   reason      short tag for log lines.
//   force       (default false) kill live holders instead of waiting.
//   timeoutMs   (default 90000) cooperative-wait budget before giving up.
//   waitMs      (default 2000) settle sleep after the profile is confirmed
//               free / after a forced kill, before the caller launches
//               Chrome. Kept for backward compatibility with existing call
//               sites that pass it.
//   dryRun      (default false) detect and log only — never wait, kill, or
//               throw. Returns immediately with what it found.
//
// Safe to call multiple times — idempotent when the profile is free. Logs
// every action to scripts/atlas-runs/chrome-unlock-YYYY-MM-DD.log (matches
// the fb-tab-preflight log naming convention).
//
// IMPORTANT — what this does NOT do:
//   - Does NOT touch Heath's main interactive Chrome (different user-data-dir).
//   - Does NOT close tabs — that's the job of fb-tab-preflight.js.
//   - Does NOT validate session state, log in, or navigate anywhere.

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUN_DIR = path.join(REPO_ROOT, 'scripts', 'atlas-runs');
if (!fs.existsSync(RUN_DIR)) {
  try { fs.mkdirSync(RUN_DIR, { recursive: true }); } catch {}
}

const STALE_LOCK_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

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

function psQuote(str) {
  return String(str).replace(/'/g, "''");
}

/**
 * Query WMI for every chrome.exe whose CommandLine references profileDir.
 * @returns {Array<{pid: string, parentPid: string, commandLine: string}>}
 */
function queryHoldingChromeProcesses(profileDir) {
  const needle1 = psQuote(profileDir);
  const needle2 = psQuote(profileDir.replace(/\\/g, '/'));
  const psScript = [
    "$ErrorActionPreference = 'SilentlyContinue';",
    `$needle1 = '${needle1}';`,
    `$needle2 = '${needle2}';`,
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ",
    "Where-Object { $_.CommandLine -and ( ($_.CommandLine -like ('*' + $needle1 + '*')) -or ($_.CommandLine -like ('*' + $needle2 + '*')) ) } | ",
    "ForEach-Object { Write-Output ($_.ProcessId.ToString() + '|' + $_.ParentProcessId.ToString() + '|' + ($_.CommandLine -replace '[\\r\\n]', ' ')) }",
  ].join('');

  let out = '';
  try {
    out = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/"/g, '\\"')}"`,
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 15000 }
    );
  } catch (e) {
    // Fail open on query error (matches old behavior of treating a
    // powershell error as "nothing found" rather than blocking forever).
    return null;
  }

  return (out || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const idx1 = line.indexOf('|');
      const idx2 = line.indexOf('|', idx1 + 1);
      if (idx1 === -1 || idx2 === -1) return null;
      return {
        pid: line.slice(0, idx1),
        parentPid: line.slice(idx1 + 1, idx2),
        commandLine: line.slice(idx2 + 1),
      };
    })
    .filter(Boolean);
}

/**
 * Best-effort: walk the parent-process chain from a chrome.exe PID looking
 * for the owning node script (Chrome's own CommandLine never names its
 * caller — the node.exe that spawned it does).
 */
function describeProcessOwner(pid) {
  try {
    let currentPid = pid;
    for (let hop = 0; hop < 6; hop++) {
      const psScript = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${currentPid}'; if ($p) { Write-Output ($p.Name + '|' + $p.ParentProcessId.ToString() + '|' + ($p.CommandLine -replace '[\\r\\n]',' ')) }`;
      const out = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/"/g, '\\"')}"`,
        { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10000 }
      ).toString().trim();
      if (!out) break;
      const idx1 = out.indexOf('|');
      const idx2 = out.indexOf('|', idx1 + 1);
      if (idx1 === -1 || idx2 === -1) break;
      const name = out.slice(0, idx1);
      const parentPid = out.slice(idx1 + 1, idx2);
      const cmd = out.slice(idx2 + 1);
      if (/node(\.exe)?$/i.test(name) && /\.js\b/i.test(cmd)) {
        const m = cmd.match(/([^\s"\\/]+\.js)\b/i);
        return `pid=${currentPid} script=${m ? m[1] : cmd.slice(0, 160)}`;
      }
      if (!parentPid || parentPid === '0' || parentPid === currentPid) break;
      currentPid = parentPid;
    }
  } catch {}
  return `pid=${pid} script=unknown (could not resolve ancestor)`;
}

function killProcesses(holders, reason, dryRun, result) {
  for (const h of holders) {
    if (dryRun) {
      logLine(reason, `DRYRUN ${h.pid} ${h.commandLine}`);
      result.matched.push(h.commandLine);
      continue;
    }
    try {
      execSync(`powershell -NoProfile -Command "Stop-Process -Id ${h.pid} -Force -ErrorAction Stop"`, {
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
      });
      result.killed += 1;
      result.matched.push(h.commandLine);
      logLine(reason, `KILL ${h.pid} ${h.commandLine}`);
    } catch (e) {
      const msg = (e && (e.stderr ? e.stderr.toString() : e.message)) || 'unknown';
      result.errors.push(`kill-failed:${h.pid}`);
      logLine(reason, `ERR kill ${h.pid}: ${msg.trim().slice(0, 300)}`);
    }
  }
}

/**
 * Clear lock artifacts left behind by a crashed/killed Chrome, and repair
 * the exit_type flag so the next launch doesn't think it's recovering from
 * a crash. Only called once we've confirmed no live process holds the
 * profile — so these are genuinely stale, not active locks.
 */
function clearStaleLockFiles(profileDir, reason, result) {
  for (const name of STALE_LOCK_FILES) {
    const p = path.join(profileDir, name);
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        logLine(reason, `cleared stale lock file: ${name}`);
        result.matched.push(`lockfile:${name}`);
      }
    } catch (e) {
      logLine(reason, `could not clear ${name}: ${e.message}`);
      result.errors.push(`lockfile-clear-failed:${name}`);
    }
  }

  try {
    const prefsPath = path.join(profileDir, 'Default', 'Preferences');
    if (fs.existsSync(prefsPath)) {
      const raw = fs.readFileSync(prefsPath, 'utf8');
      if (raw.includes('"exit_type":"Crashed"')) {
        fs.writeFileSync(prefsPath, raw.replace(/"exit_type":"Crashed"/g, '"exit_type":"Normal"'), 'utf8');
        logLine(reason, 'repaired exit_type Crashed -> Normal in Default/Preferences');
      }
    }
  } catch (e) {
    logLine(reason, `could not repair exit_type: ${e.message}`);
  }
}

/**
 * Make a Chrome user-data-dir safe to launch against. See file header for
 * full strategy. Cooperative (wait, don't kill) by default; pass
 * `force: true` to restore the old kill-on-sight behavior.
 *
 * @param {object} opts
 * @param {string} opts.profileDir
 * @param {string} [opts.reason]
 * @param {boolean} [opts.force=false]      Kill live holders instead of waiting.
 * @param {number} [opts.timeoutMs=90000]   Cooperative-wait budget.
 * @param {number} [opts.waitMs=2000]       Settle sleep once the profile is free.
 * @param {boolean} [opts.dryRun=false]     Detect + log only, no wait/kill/throw.
 * @returns {Promise<{killed:number, matched:string[], errors:string[], waited:boolean, waitedMs:number}>}
 */
async function unlockProfile(opts = {}) {
  const profileDir = opts.profileDir;
  const reason = opts.reason || 'chrome-unlock';
  const waitMs = typeof opts.waitMs === 'number' ? opts.waitMs : 2000;
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 90000;
  const dryRun = !!opts.dryRun;
  const force = !!opts.force;

  const result = { killed: 0, matched: [], errors: [], waited: false, waitedMs: 0 };

  if (!profileDir || typeof profileDir !== 'string') {
    logLine(reason, 'ERROR: profileDir is required');
    result.errors.push('profileDir-required');
    return result;
  }

  const normalized = path.resolve(profileDir);
  logLine(reason, `start dryRun=${dryRun} force=${force} timeoutMs=${timeoutMs} profileDir=${normalized}`);

  const startTime = Date.now();
  let holders = queryHoldingChromeProcesses(normalized);
  if (holders === null) {
    logLine(reason, 'powershell query error — treating as no holder (fail-open)');
    holders = [];
    result.errors.push('powershell-query-error');
  }

  if (dryRun) {
    if (holders.length === 0) {
      logLine(reason, 'DRYRUN: no live chrome holding profile');
    } else {
      for (const h of holders) {
        logLine(reason, `DRYRUN ${h.pid} ${h.commandLine}`);
        result.matched.push(h.commandLine);
      }
    }
    return result;
  }

  if (holders.length === 0) {
    clearStaleLockFiles(normalized, reason, result);
    logLine(reason, 'no live chrome holding profile — proceeding');
    if (waitMs > 0) {
      logLine(reason, `sleep ${waitMs}ms for handle release`);
      await sleep(waitMs);
    }
    logLine(reason, `end killed=0 matched=${result.matched.length} errors=${result.errors.length}`);
    return result;
  }

  if (force) {
    logLine(reason, `force=true — killing ${holders.length} holder(s) instead of waiting`);
    killProcesses(holders, reason, false, result);
    if (waitMs > 0) {
      logLine(reason, `sleep ${waitMs}ms for handle release`);
      await sleep(waitMs);
    }
    logLine(reason, `end killed=${result.killed} matched=${result.matched.length} errors=${result.errors.length} (forced)`);
    return result;
  }

  // Cooperative path: wait with backoff, never kill.
  logLine(
    reason,
    `profile actively held by pid(s) ${holders.map((h) => h.pid).join(',')} — waiting up to ${timeoutMs}ms (cooperative, no kill)`
  );
  let backoff = 1000;
  while (Date.now() - startTime < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - startTime);
    await sleep(Math.max(0, Math.min(backoff, remaining)));
    result.waitedMs = Date.now() - startTime;

    const recheck = queryHoldingChromeProcesses(normalized);
    holders = recheck === null ? [] : recheck;

    if (holders.length === 0) {
      result.waited = true;
      clearStaleLockFiles(normalized, reason, result);
      logLine(reason, `holder released after ${result.waitedMs}ms — proceeding`);
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      logLine(reason, `end killed=0 matched=${result.matched.length} errors=${result.errors.length} waitedMs=${result.waitedMs}`);
      return result;
    }
    backoff = Math.min(backoff * 1.5, 8000);
  }

  const owners = holders.map((h) => describeProcessOwner(h.pid));
  const msg = `Profile "${normalized}" still held after ${timeoutMs}ms by: ${owners.join('; ')}. Not killing — pass { force: true } to override.`;
  logLine(reason, `TIMEOUT ${msg}`);
  const err = new Error(msg);
  err.code = 'BROKERAGE_PROFILE_LOCKED';
  err.holders = holders;
  throw err;
}

module.exports = { unlockProfile };

// Allow direct CLI invocation:
//   node scripts/_lib/chrome-profile-unlock.js <profile-dir> [reason] [--dry-run] [--force] [--timeout-ms N]
if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const dryRun = argv.includes('--dry-run');
    const force = argv.includes('--force');
    const timeoutIdx = argv.indexOf('--timeout-ms');
    const timeoutMs = timeoutIdx !== -1 ? Number(argv[timeoutIdx + 1]) : undefined;
    const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--timeout-ms');
    const profileDir = positional[0];
    const reason = positional[1] || 'cli';
    if (!profileDir) {
      console.error('Usage: node scripts/_lib/chrome-profile-unlock.js <profile-dir> [reason] [--dry-run] [--force] [--timeout-ms N]');
      process.exit(2);
    }
    try {
      const r = await unlockProfile({ profileDir, reason, dryRun, force, timeoutMs });
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  })();
}
