#!/usr/bin/env node
'use strict';

// scripts/agent-dispatch-preflight.js
// =========================================================================
// PREFLIGHT GATE FOR AGENT DISPATCH — run before dispatching any browser-
// driving or repo-touching agent.
//
//   node scripts/agent-dispatch-preflight.js
//   node scripts/agent-dispatch-preflight.js --json
//
// Read-only. Never waits, kills, or mutates anything. Target < 5s.
//
// WHY THIS EXISTS
// ----------------
// 2026-09-10: three separate collisions in one day, all from dispatching
// agents into shared, exclusive resources without checking first:
//   1. Two agents launched against ~/.brokerage-browser-profile (zipForm +
//      connectMLS). The second sat in the cooperative unlock wait forever.
//      Both reported "running." Only Heath noticing surfaced it.
//   2. An agent taskkill'd a Chrome holding Heath's authenticated zipForm
//      session to free that same lock. He re-authenticated by hand twice.
//   3. An agent ran `git checkout main` + merge in the SHARED working tree,
//      silently wiping another agent's uncommitted edits.
// The rule "one agent per shared resource" already existed in memory
// (feedback_conserve-max-plan-usage) and was violated anyway, under load.
// Rules that live only in memory fail under load; rules enforced in code
// don't. See feedback_isolate-agents-in-worktrees.md and
// feedback_self-detect-stalls-dont-wait-for-heath.md for full incident
// detail. This script is the mechanical version of that memory.
//
// WHAT IT CHECKS
//   chrome:<profile>   Is a live Chrome process holding this exclusive
//                       profile dir right now, and (best-effort) which
//                       script/PID owns it? Three profiles are checked:
//                       zipform-connectmls (~/.brokerage-browser-profile —
//                       these two products share ONE profile, they only
//                       look separate), brokerage-command (KW Command),
//                       dossiebot-sage (FB/IG engagement).
//   zipform-session-risk  Specific composite: is the zipform-connectmls
//                       profile currently HELD by a live Chrome? If yes,
//                       killing it risks destroying an authenticated
//                       session Heath would have to re-establish by hand.
//                       This is a warning gate, not a session probe — it
//                       does not (and cannot, read-only) confirm a tab is
//                       actually signed in right now.
//   shared-tree-git     Is the shared checkout (main MeetDossie working
//                       tree, not a worktree) on a clean git status, and
//                       which branch? A dispatch that will run git here
//                       is exactly the collision that destroyed work.
//   worktrees           How many git worktrees exist under
//                       .claude/worktrees/, how many are currently locked
//                       (in use by a live agent dispatch) vs free to reuse
//                       or clean up.
//
// KNOWN-UNRELIABLE CHECK — READ BEFORE TRUSTING chrome:* ROWS
// -------------------------------------------------------------
// The chrome:* checks shell out to `powershell.exe` (Get-CimInstance
// Win32_Process) from WSL. That WSL->Windows boundary has known quoting
// flakiness (see scripts/_lib/chrome-profile-unlock.js header, 2026-08-30
// incident). When the query itself errors, this script reports the row as
// UNKNOWN, not FREE — a failed query is NOT evidence the profile is free.
// If you see UNKNOWN, treat it as "assume held" for dispatch-safety purposes
// and check manually (Task Manager / `tasklist`) before proceeding. Do not
// let a flaky query fail open into a false "safe to launch."
//
// shared-tree-git is fully answerable only when THIS script itself is run
// from the shared checkout (not from inside a worktree) — the sandbox that
// isolates worktree-scoped agents refuses to let a worktree-isolated
// process redirect git at the shared tree (`-C`, `cd`, or any indirect
// form), which is a real, independently-enforced safety net, not a bug in
// this script. Run this from Cole's own (non-isolated) shell/context before
// dispatch; if it's run from inside a worktree, that row reports BLOCKED
// with the reason, rather than silently reporting clean.
//
// Owner: Atlas. Pattern reused from scripts/preflight-check.js — same
// pass/fail table shape, do not invent a new output format.

const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const fs = require('fs');

const { queryHoldingChromeProcesses, describeProcessOwner } = require('./_lib/chrome-profile-unlock');

const JSON_MODE = process.argv.includes('--json');
const TIMEOUT_MS = 15000;

// Canonical shared-checkout path (CLAUDE.md Section 2) — checked regardless
// of where this script itself physically lives, because worktree copies of
// this file all need to answer "is the SHARED tree safe," not "am I clean."
const SHARED_REPO_PATH = '/mnt/c/Users/Heath/Projects/MeetDossie';
const WORKTREES_DIR = path.join(SHARED_REPO_PATH, '.claude', 'worktrees');

// Exclusive Chrome profiles — Windows-style paths because that's the exact
// string Playwright hands to the real (Windows) Chrome binary, and that's
// the string PowerShell's CommandLine match needs (chrome-profile-unlock.js
// matches both slash styles, but the canonical form used at launch time is
// this one — see scripts/_lib/brokerage-browser.js BROKERAGE_PROFILE_DIR).
const PROFILES = [
  {
    id: 'zipform-connectmls',
    label: 'Chrome: zipForm + connectMLS profile',
    dir: process.env.BROKERAGE_PROFILE_DIR || 'C:\\Users\\Heath\\.brokerage-browser-profile',
    note: 'zipForm AND connectMLS both live in this ONE profile — they look separate, they are not.',
  },
  {
    id: 'brokerage-command',
    label: 'Chrome: KW Command profile',
    dir: process.env.BROKERAGE_COMMAND_PROFILE_DIR || 'C:\\Users\\Heath\\.brokerage-command-profile',
    note: null,
  },
  {
    id: 'dossiebot-sage',
    label: 'Chrome: DossieBot-Sage profile',
    dir: process.env.SAGE_PROFILE_DIR || 'C:\\Users\\Heath\\AppData\\Local\\DossieBot-Sage',
    note: 'FB/IG group engagement (comment/post automation).',
  },
];

// Saved-session cookie file used elsewhere (scripts/preflight-check.js) as a
// cheap, read-only proxy for "has a zipForm/connectMLS login been captured."
// Same caveat as that script documents: this inspects a SAVED STATE FILE,
// not the live browser tab. It cannot prove today's open Chrome window is
// still signed in — it can only say whether a real login was ever captured
// and whether those cookies haven't expired.
const BROWSER_STATE_FILE =
  process.env.PREFLIGHT_STATE_FILE ||
  path.join(os.homedir().startsWith('/home') ? '/mnt/c/Users/Heath' : os.homedir(), '.brokerage-browser-state.json');

function withTimeoutSync(fn, label) {
  // execFileSync calls below already carry their own timeout; this wrapper
  // just normalizes unexpected throws into a row shape.
  try {
    return fn();
  } catch (e) {
    return { status: 'FAIL', error: (e && e.message || String(e)).slice(0, 200) };
  }
}

// --------------------------------------------------------------- chrome:*
function checkChromeProfile(profile) {
  const holders = queryHoldingChromeProcesses(profile.dir);

  if (holders === null) {
    return {
      status: 'WARN',
      detail: `UNKNOWN — PowerShell/WMI query failed (WSL boundary flake). Do NOT assume free; verify manually before launching.`,
    };
  }
  if (holders.length === 0) {
    return { status: 'OK', detail: 'free — no live Chrome holding this profile' };
  }
  const owners = holders.map((h) => describeProcessOwner(h.pid));
  return {
    status: 'WARN',
    detail: `HELD by ${holders.length} process(es): ${owners.join('; ')}${profile.note ? ` — ${profile.note}` : ''}`,
  };
}

// ------------------------------------------------------- zipform-session-risk
function checkZipformSessionRisk(zipformHolders) {
  if (zipformHolders === null) {
    return { status: 'WARN', detail: 'UNKNOWN whether profile is held — treat as risky, do not force-kill anything against this profile.' };
  }
  if (zipformHolders.length === 0) {
    return { status: 'OK', detail: 'no live Chrome on this profile right now — safe to launch a fresh context.' };
  }

  let cookieNote = 'saved-state file not checked/found (proxy only, not a live-session probe)';
  try {
    if (fs.existsSync(BROWSER_STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(BROWSER_STATE_FILE, 'utf8'));
      const nowSec = Date.now() / 1000;
      const zf = (state.cookies || []).filter((c) => /zipformplus/i.test(c.domain || ''));
      const liveZf = zf.filter((c) => !c.expires || c.expires < 0 || c.expires > nowSec);
      cookieNote = liveZf.length
        ? `saved state shows ${liveZf.length} live zipForm cookie(s) — a real session has been captured here before`
        : 'saved state has no live zipForm cookies (may still be logged in interactively; this is a proxy, not proof)';
    }
  } catch { /* non-fatal, keep default note */ }

  return {
    status: 'WARN',
    detail: `Chrome IS holding this profile — DO NOT force-kill. ${cookieNote}. Wait for it to release, or TaskStop the owning agent.`,
  };
}

// ----------------------------------------------------------- shared-tree-git
function checkSharedTreeGit() {
  // Detect whether we're currently executing from inside a worktree — the
  // sandbox refuses `-C`/`cd` redirection at the shared tree from there, so
  // don't even attempt it; report the real constraint instead of a fake result.
  const cwdReal = fs.realpathSync(process.cwd());
  const insideWorktree = cwdReal.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`)
    || cwdReal.includes('/.claude/worktrees/');

  if (insideWorktree) {
    return {
      status: 'WARN',
      detail: 'BLOCKED — running from inside a worktree; the sandbox refuses to let an isolated agent redirect git at the shared tree. Run this preflight from the main checkout to see shared-tree dirty state.',
    };
  }

  return withTimeoutSync(() => {
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd: SHARED_REPO_PATH, encoding: 'utf8', timeout: TIMEOUT_MS,
    }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: SHARED_REPO_PATH, encoding: 'utf8', timeout: TIMEOUT_MS,
    });
    const dirtyLines = status.split('\n').filter((l) => l.trim()).length;
    if (dirtyLines > 0) {
      return {
        status: 'WARN',
        detail: `branch "${branch}", ${dirtyLines} uncommitted change(s) — do NOT run git (checkout/merge/reset) here; dispatch to a worktree instead.`,
      };
    }
    return { status: 'OK', detail: `branch "${branch}", clean` };
  }, 'shared-tree-git');
}

// ----------------------------------------------------------------- worktrees
function checkWorktrees() {
  return withTimeoutSync(() => {
    const raw = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      encoding: 'utf8', timeout: TIMEOUT_MS,
    });
    const blocks = raw.split('\n\n').map((b) => b.trim()).filter(Boolean);
    let total = 0, locked = 0, sharedFound = false;
    for (const b of blocks) {
      const wtLine = b.split('\n').find((l) => l.startsWith('worktree '));
      if (!wtLine) continue;
      const wtPath = wtLine.slice('worktree '.length).trim();
      if (wtPath === SHARED_REPO_PATH) { sharedFound = true; continue; }
      total += 1;
      if (/^locked\b/m.test(b)) locked += 1;
    }
    const free = total - locked;
    return {
      status: 'OK',
      detail: `${total} agent worktree(s) under .claude/worktrees/ — ${locked} locked (in use), ${free} free/reusable${sharedFound ? '' : ' (WARNING: shared checkout not found in worktree list — unexpected)'}`,
    };
  }, 'worktrees');
}

// --------------------------------------------------------------------- main

function main() {
  const t0 = Date.now();
  const rows = [];

  const zipformHolders = queryHoldingChromeProcesses(PROFILES[0].dir);

  for (const profile of PROFILES) {
    const res = profile.id === 'zipform-connectmls'
      ? (zipformHolders === null
          ? { status: 'WARN', detail: 'UNKNOWN — PowerShell/WMI query failed. Do NOT assume free.' }
          : zipformHolders.length === 0
            ? { status: 'OK', detail: 'free — no live Chrome holding this profile' }
            : { status: 'WARN', detail: `HELD by ${zipformHolders.length} process(es): ${zipformHolders.map((h) => describeProcessOwner(h.pid)).join('; ')} — ${profile.note}` })
      : checkChromeProfile(profile);
    rows.push({ id: profile.id, label: profile.label, ...res });
  }

  rows.push({ id: 'zipform-session-risk', label: 'zipForm session kill-risk', ...checkZipformSessionRisk(zipformHolders) });
  rows.push({ id: 'shared-tree-git', label: 'Shared tree git state', ...checkSharedTreeGit() });
  rows.push({ id: 'worktrees', label: 'Worktree pool', ...checkWorktrees() });

  const fails = rows.filter((r) => r.status === 'FAIL');
  const warns = rows.filter((r) => r.status === 'WARN');
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (JSON_MODE) {
    console.log(JSON.stringify({ ok: fails.length === 0, warnCount: warns.length, elapsedMs: Date.now() - t0, results: rows }, null, 2));
  } else {
    const width = Math.max(...rows.map((r) => r.label.length));
    const ICON = { OK: '✅', WARN: '⚠️ ', FAIL: '❌' };
    console.log('\nAGENT DISPATCH PREFLIGHT — shared-resource + git safety gate');
    console.log('-'.repeat(width + 60));
    for (const r of rows) {
      console.log(`${ICON[r.status]}  ${r.label.padEnd(width)}  ${r.detail || r.error}`);
    }
    console.log('-'.repeat(width + 60));
    console.log(`${rows.length - fails.length - warns.length} ok / ${warns.length} warn / ${fails.length} fail  ·  ${elapsed}s`);

    const zfHeld = zipformHolders === null || zipformHolders.length > 0;
    const treeDirty = rows.find((r) => r.id === 'shared-tree-git' && r.status === 'WARN' && /uncommitted/.test(r.detail || ''));
    console.log('');
    console.log(`GATE — browser dispatch (zipForm/connectMLS): ${zfHeld ? 'DO NOT LAUNCH — profile busy or unknown' : 'safe to launch'}`);
    console.log(`GATE — git in shared tree:                    ${treeDirty ? 'DO NOT RUN GIT HERE — dispatch to a worktree' : 'appears safe (verify branch above)'}`);
    console.log('');
    if (fails.length) console.log(`FAILING: ${fails.map((f) => f.id).join(', ')} — investigate before dispatch.\n`);
  }

  process.exit(fails.length ? 1 : 0);
}

main();
