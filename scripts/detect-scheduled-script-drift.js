#!/usr/bin/env node
'use strict';

// scripts/detect-scheduled-script-drift.js
//
// Heath, 2026-09-16: twice in one day a merged fix did NOTHING because this
// machine's working tree was stale -- Windows Task Scheduler runs the LOCAL
// files on disk and nothing ever pulls `main` into them. Six scripts were
// found running old code that day, including libs no .cmd/.ps1 ever names
// directly (they only show up by following the require() graph).
//
// WHAT THIS DOES
//   1. Enumerates every Windows Scheduled Task whose action touches this
//      repo (`schtasks /query /xml`, cached -- see TASK_CACHE_TTL_MS).
//   2. From each task's entry file (.ps1/.vbs/.cmd/.sh/.js), follows the
//      real invocation graph: .cmd "node scripts\X.js" lines, .vbs
//      WshShell.Run command strings, .ps1 $var = 'scripts\X.js' + node
//      invocations, .sh interpreter calls, and JS require('./relative')
//      chains (recursive) -- so a _lib/*.js file a wrapper never names
//      directly is still covered.
//   3. For every file in that closure, classifies it against git:
//        - UNTRACKED   -- not in git at all (skip, informational only)
//        - MODIFIED    -- working tree differs from HEAD (Heath has real
//                         WIP here). Reported separately. NEVER touched,
//                         never counted as "stale", never the reason to
//                         alert.
//        - STALE       -- working tree matches HEAD (clean) but HEAD's
//                         content differs from origin/main. This is the
//                         exact failure mode from today: the scheduler is
//                         running code that doesn't match what's merged.
//        - clean        -- matches origin/main, nothing to do.
//   4. Dedupes/alerts via the SAME `alert_state` table
//      api/_lib/silence-alarm.js uses (key='scheduled_script_drift') --
//      fires on a NEW stale-file-set, or on the same one after
//      ALERT_COOLDOWN_HOURS, never more than once per run.
//   5. ALWAYS upserts alert_state.metadata (even on a clean run) so
//      api/cron-dossie-full-diagnostic.js (the daily 5AM heartbeat) can
//      read the latest check and add it alongside its other queue-health
//      lines -- a quiet drift still shows up there even if the Telegram
//      alert was missed or this machine was off when it would have fired.
//
// HARD RULE: detect and report ONLY. This file never runs `git checkout`,
// `git stash`, `git reset`, or writes to any tracked file in the repo. The
// only writes are: its own cache/state file (gitignored) and, over the
// network, alert_state rows + a Telegram message.
//
// Usage:
//   node scripts/detect-scheduled-script-drift.js               # real run
//   node scripts/detect-scheduled-script-drift.js --dry-run      # print only, no Supabase/Telegram writes
//   node scripts/detect-scheduled-script-drift.js --repo-root <path>   # evaluate a different checkout (testing)
//   node scripts/detect-scheduled-script-drift.js --alert-key <key>    # override alert_state key (testing)
//   node scripts/detect-scheduled-script-drift.js --no-cache     # force a fresh schtasks query
//
// Folded into the 15-min "Dossie TC Discovery Harvest" tick
// (scripts/run-tc-discovery-harvest.cmd, Step 10) -- cost per tick is one
// `git fetch origin main` + two `git diff --name-only` calls (cheap, no
// Chrome), plus an amortized schtasks query (cached, see TASK_CACHE_TTL_MS).
//
// Owner: Atlas, 2026-09-16

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

// Load .env.local when running locally (same pattern as
// scripts/harvest-tc-discovery-responses.js).
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch (e) { /* non-fatal */ }

// ---- CLI args --------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name) { return argv.includes(name); }
function opt(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}

const DRY_RUN = flag('--dry-run');
const NO_CACHE = flag('--no-cache');
const REPO_ROOT = path.resolve(opt('--repo-root', path.join(__dirname, '..')));
const ALERT_KEY = opt('--alert-key', 'scheduled_script_drift');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const ALERT_COOLDOWN_HOURS = 12; // repeat-nag interval for an UNRESOLVED same-file-set drift
const TASK_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // schtasks rarely changes -- refresh once/day
const TASK_CACHE_FILE = path.join(__dirname, '.stale-script-detector-task-cache.json');

function log(msg) {
  console.log(`[detect-scheduled-script-drift] ${msg}`);
}

// ---- git helpers -------------------------------------------------------
function git(args) {
  return execSync(`git ${args}`, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}
function safeGit(args, fallback = '') {
  try { return git(args); } catch (e) { return fallback; }
}
function linesOf(s) {
  return String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);
}

// ---- Task Scheduler enumeration -----------------------------------------
function getTasksXmlRaw() {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'schtasks /query /xml' : 'cmd.exe /c "schtasks /query /xml"';
  return execSync(cmd, { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
}

function parseTasks(xml) {
  const tasks = [];
  // Each task is preceded by an XML comment marker: <!-- \TaskName -->
  const re = /<!-- (\\[^\r\n]+) -->([\s\S]*?)(?=<!-- \\|$)/g;
  let m;
  while ((m = re.exec(xml))) {
    const name = m[1].trim();
    const body = m[2];
    const cmdM = /<Command>([\s\S]*?)<\/Command>/.exec(body);
    const argsM = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(body);
    const repM = /<Repetition>\s*<Interval>([\s\S]*?)<\/Interval>/.exec(body);
    tasks.push({
      name,
      command: cmdM ? cmdM[1].trim() : '',
      args: argsM ? argsM[1].trim() : '',
      interval: repM ? repM[1].trim() : null,
    });
  }
  return tasks;
}

function loadTasks() {
  if (!NO_CACHE) {
    try {
      if (fs.existsSync(TASK_CACHE_FILE)) {
        const cache = JSON.parse(fs.readFileSync(TASK_CACHE_FILE, 'utf8'));
        if (cache.cachedAt && Date.now() - new Date(cache.cachedAt).getTime() < TASK_CACHE_TTL_MS) {
          log(`using cached task list (${cache.tasks.length} MeetDossie tasks, cached ${cache.cachedAt})`);
          return cache.tasks;
        }
      }
    } catch (e) { /* fall through to a fresh query */ }
  }

  let xml;
  try {
    xml = getTasksXmlRaw();
  } catch (e) {
    log(`WARN: schtasks query failed (${e.message}) -- falling back to stale cache if any`);
    try {
      if (fs.existsSync(TASK_CACHE_FILE)) {
        return JSON.parse(fs.readFileSync(TASK_CACHE_FILE, 'utf8')).tasks;
      }
    } catch (_e) { /* noop */ }
    return [];
  }

  const all = parseTasks(xml);
  const meetDossie = all.filter((t) => (t.command + ' ' + t.args).includes('MeetDossie'));

  try {
    fs.writeFileSync(TASK_CACHE_FILE, JSON.stringify({ cachedAt: new Date().toISOString(), tasks: meetDossie }, null, 2));
  } catch (e) { /* non-fatal */ }

  log(`schtasks query: ${all.length} total tasks, ${meetDossie.length} touch MeetDossie`);
  return meetDossie;
}

// ---- path extraction / normalization ------------------------------------
// Absolute "C:\Users\Heath\Projects\MeetDossie\..." paths anywhere in a
// command line or wrapper script body.
const WIN_ABS_RE = /[A-Za-z]:\\Users\\Heath\\Projects\\MeetDossie\\[^"'\s]+/g;
// Relative "scripts\X.js" / "scripts/X.py" / "api/X.js" references (what
// the .cmd wrapper actually writes on each line).
const REL_RE = /\b(?:scripts|api)[\\/][\w.\-\\/]*\.(?:js|py|ps1|sh|cmd|vbs|ts)\b/g;

function stripTrailingPunct(p) {
  return p.replace(/["')>;,]+$/g, '');
}

function winAbsToRepoRelative(winPath) {
  const marker = 'MeetDossie\\';
  const idx = winPath.indexOf(marker);
  if (idx === -1) return null;
  return stripTrailingPunct(winPath.slice(idx + marker.length).replace(/\\/g, '/'));
}

function extractReferencedFiles(text) {
  const found = new Set();
  let m;
  WIN_ABS_RE.lastIndex = 0;
  while ((m = WIN_ABS_RE.exec(text))) {
    const rel = winAbsToRepoRelative(m[0]);
    if (rel) found.add(rel);
  }
  REL_RE.lastIndex = 0;
  while ((m = REL_RE.exec(text))) {
    found.add(stripTrailingPunct(m[0].replace(/\\/g, '/')));
  }
  return found;
}

// ---- JS require() graph --------------------------------------------------
function extractRequireSpecs(jsText) {
  const specs = [];
  const re = /require\(\s*(['"])(\.[^'"]+)\1\s*\)/g;
  let m;
  while ((m = re.exec(jsText))) specs.push(m[2]);
  return specs;
}

function resolveRequire(fromFileRel, spec) {
  const dir = path.dirname(path.join(REPO_ROOT, fromFileRel));
  const resolved = path.resolve(dir, spec);
  const rel = path.relative(REPO_ROOT, resolved).replace(/\\/g, '/');
  const candidates = [rel, `${rel}.js`, `${rel}/index.js`];
  for (const c of candidates) {
    const abs = path.join(REPO_ROOT, c);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return c;
  }
  return null;
}

// ---- best-effort Python import graph -------------------------------------
function extractPyReferencedFiles(pyText, fromFileRel) {
  const found = new Set();
  const dir = path.dirname(fromFileRel);
  let m;
  const reAbs = /^\s*from\s+scripts\.([\w.]+)\s+import/gm;
  while ((m = reAbs.exec(pyText))) found.add(`scripts/${m[1].replace(/\./g, '/')}.py`);
  const reRel = /^\s*from\s+\.([\w.]*)\s+import\s+([\w, ]+)/gm;
  while ((m = reRel.exec(pyText))) {
    const sub = m[1];
    if (sub) {
      found.add(`${dir}/${sub.replace(/\./g, '/')}.py`);
    } else {
      for (const n of m[2].split(',').map((s) => s.trim()).filter(Boolean)) {
        found.add(`${dir}/${n}.py`);
      }
    }
  }
  return found;
}

// ---- BFS closure per task -------------------------------------------------
function fileExists(rel) {
  const abs = path.join(REPO_ROOT, rel);
  return fs.existsSync(abs) && fs.statSync(abs).isFile();
}

function closureFor(seedFiles) {
  const visited = new Set();
  const queue = [...seedFiles];
  while (queue.length) {
    const f = queue.shift();
    if (visited.has(f)) continue;
    visited.add(f);
    if (!fileExists(f)) continue;
    let text;
    try { text = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'); } catch (e) { continue; }

    if (f.endsWith('.js')) {
      for (const spec of extractRequireSpecs(text)) {
        const r = resolveRequire(f, spec);
        if (r && !visited.has(r)) queue.push(r);
      }
    } else if (f.endsWith('.py')) {
      for (const r of extractPyReferencedFiles(text, f)) {
        if (!visited.has(r)) queue.push(r);
      }
    } else {
      // .cmd / .vbs / .sh / .ps1 wrapper -- scan the body for further
      // referenced repo files (both absolute-Windows and relative forms).
      for (const r of extractReferencedFiles(text)) {
        if (!visited.has(r)) queue.push(r);
      }
    }
  }
  return visited;
}

function buildFullClosure(tasks) {
  // file -> Set(task names that reach it)
  const owners = new Map();
  for (const task of tasks) {
    const seedLine = `${task.command} ${task.args}`;
    const seeds = [...extractReferencedFiles(seedLine)];
    if (seeds.length === 0) continue;
    const closure = closureFor(seeds);
    for (const f of closure) {
      if (!owners.has(f)) owners.set(f, new Set());
      owners.get(f).add(task.name);
    }
  }
  return owners;
}

// ---- drift classification -------------------------------------------------
function computeDrift() {
  const fetchOut = safeGit('fetch origin main --quiet', null);
  const fetchOk = fetchOut !== null;
  if (!fetchOk) log('WARN: git fetch origin main failed -- comparing against last-known origin/main');

  const trackedSet = new Set(linesOf(safeGit('ls-files')));
  const modifiedSet = new Set([
    ...linesOf(safeGit('diff --name-only HEAD')),
    ...linesOf(safeGit('diff --name-only --cached HEAD')),
  ]);
  const originDiffSet = new Set(linesOf(safeGit('diff --name-only origin/main HEAD')));

  const localHeadSha = safeGit('rev-parse --short HEAD').trim();
  const originMainSha = safeGit('rev-parse --short origin/main').trim();
  const branch = safeGit('rev-parse --abbrev-ref HEAD').trim();

  return { trackedSet, modifiedSet, originDiffSet, localHeadSha, originMainSha, branch, fetchOk };
}

function classify(file, drift) {
  if (!drift.trackedSet.has(file)) return 'untracked';
  if (drift.modifiedSet.has(file)) return 'modified';
  if (drift.originDiffSet.has(file)) return 'stale';
  return 'clean';
}

// ---- alert_state (dedupe, same table as api/_lib/silence-alarm.js) -------
async function supabaseFetch(p, init = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return { ok: false, status: 0, data: null };
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${p}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

async function getAlertState(key) {
  const r = await supabaseFetch(`/rest/v1/alert_state?key=eq.${encodeURIComponent(key)}&select=*`);
  return r.ok && Array.isArray(r.data) && r.data[0] ? r.data[0] : null;
}

async function upsertAlertState(key, metadata, fired, reason) {
  const body = {
    key,
    metadata,
    updated_at: new Date().toISOString(),
    ...(fired ? { last_fired_at: new Date().toISOString(), last_reason: reason } : {}),
  };
  await supabaseFetch('/rest/v1/alert_state?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(body),
  });
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log('WARN: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set -- cannot alert');
    return false;
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  return res.ok;
}

function fileHash(list) {
  return crypto.createHash('md5').update(JSON.stringify(list.slice().sort())).digest('hex');
}

// ---- main -----------------------------------------------------------------
async function main() {
  const tasks = loadTasks();
  if (tasks.length === 0) {
    log('no MeetDossie scheduled tasks found -- nothing to check');
    return;
  }

  const owners = buildFullClosure(tasks);
  const drift = computeDrift();

  const stale = [];
  const modified = [];
  const untracked = [];

  for (const [file, taskSet] of owners) {
    const category = classify(file, drift);
    const entry = { file, tasks: [...taskSet] };
    if (category === 'stale') stale.push(entry);
    else if (category === 'modified') modified.push(entry);
    else if (category === 'untracked') untracked.push(entry);
  }

  stale.sort((a, b) => a.file.localeCompare(b.file));
  modified.sort((a, b) => a.file.localeCompare(b.file));

  log(`closure: ${owners.size} files across ${tasks.length} tasks`);
  log(`stale=${stale.length} modified=${modified.length} untracked=${untracked.length}`);
  if (stale.length) log('STALE: ' + stale.map((s) => s.file).join(', '));
  if (modified.length) log('MODIFIED (review manually, not alerted): ' + modified.map((s) => s.file).join(', '));
  if (untracked.length) log('untracked (not in git, informational only): ' + untracked.map((s) => s.file).join(', '));

  const metadata = {
    checked_at: new Date().toISOString(),
    branch: drift.branch,
    local_head_sha: drift.localHeadSha,
    origin_main_sha: drift.originMainSha,
    fetch_ok: drift.fetchOk,
    stale_count: stale.length,
    stale_files: stale.map((s) => ({ file: s.file, tasks: s.tasks })),
    modified_count: modified.length,
    modified_files: modified.map((s) => s.file),
    tasks_checked: tasks.map((t) => t.name),
  };

  let fired = false;
  let reason = null;

  if (stale.length > 0) {
    const currentHash = fileHash(stale.map((s) => s.file));
    const prev = DRY_RUN ? null : await getAlertState(ALERT_KEY);
    const prevHash = prev && prev.metadata && prev.metadata.stale_files
      ? fileHash(prev.metadata.stale_files.map((s) => s.file))
      : null;
    const lastFiredAt = prev && prev.last_fired_at ? new Date(prev.last_fired_at).getTime() : 0;
    const cooldownElapsed = Date.now() - lastFiredAt > ALERT_COOLDOWN_HOURS * 60 * 60 * 1000;
    const isNewCondition = currentHash !== prevHash;

    if (isNewCondition || cooldownElapsed) {
      reason = `${stale.length} scheduled script file(s) diverged from origin/main`;
      const lines = stale.map((s) => `  - ${s.file}\n      used by: ${s.tasks.join(', ')}`).join('\n');
      const text =
        `STALE SCHEDULED SCRIPT${stale.length > 1 ? 'S' : ''} DETECTED\n\n` +
        `Local HEAD (${drift.branch}@${drift.localHeadSha}) is CLEAN for these files but differs ` +
        `from origin/main (${drift.originMainSha}) -- Task Scheduler is running old code:\n\n${lines}\n\n` +
        `Fix: git pull origin main  (or have an agent sync the working tree). ` +
        `Not fixed automatically -- detect and report only.`;
      if (DRY_RUN) {
        log('DRY RUN -- would send Telegram alert:\n' + text);
      } else {
        fired = await sendTelegram(text);
        if (!fired) log('WARN: Telegram send failed/skipped -- not stamping last_fired_at');
      }
    } else {
      log(`stale condition unchanged and within ${ALERT_COOLDOWN_HOURS}h cooldown -- suppressing repeat alert`);
    }
  }

  if (!DRY_RUN) {
    await upsertAlertState(ALERT_KEY, metadata, fired, reason);
  } else {
    log('DRY RUN -- not writing alert_state');
  }
}

main().catch((err) => {
  console.error('[detect-scheduled-script-drift] FATAL:', err && err.stack || err);
  process.exitCode = 1;
});
