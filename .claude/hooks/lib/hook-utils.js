'use strict';
/**
 * Shared helpers for the guard hooks (pretooluse-guard.js, postcompact-reanchor.js).
 * Every function here is best-effort and MUST NOT throw past its caller —
 * hook scripts wrap all of this in try/catch and fail open (exit 0) with a
 * loud log line rather than silently doing nothing or accidentally exiting 1
 * (exit 1 does not block on PreToolUse but it also isn't "silent" — we still
 * want a log line every time something goes wrong).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function readStdinJSON() {
  const raw = fs.readFileSync(0, 'utf-8');
  return JSON.parse(raw);
}

function hooksDir(cwd) {
  return path.join(cwd, '.claude', 'hooks');
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
}

/** Append one JSON line to a log file under .claude/hooks/logs/<name>, cwd-scoped. */
function appendLog(cwd, name, obj) {
  try {
    const dir = path.join(hooksDir(cwd), 'logs');
    ensureDir(dir);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n';
    fs.appendFileSync(path.join(dir, name), line);
  } catch (e) {
    // Logging must never crash the hook. There is genuinely nowhere safer
    // to report this failure, so it is swallowed on purpose.
  }
}

/** Touch a heartbeat file every time a guard hook runs, so staleness/inertness is detectable. */
function heartbeat(cwd, name) {
  try {
    const dir = path.join(hooksDir(cwd), 'state');
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, name), new Date().toISOString());
  } catch (e) { /* ignore */ }
}

function readState(cwd, name) {
  try {
    return fs.readFileSync(path.join(hooksDir(cwd), 'state', name), 'utf-8').trim();
  } catch (e) {
    return null;
  }
}

function writeState(cwd, name, value) {
  try {
    const dir = path.join(hooksDir(cwd), 'state');
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, name), value);
  } catch (e) { /* ignore */ }
}

function clearState(cwd, name) {
  try { fs.unlinkSync(path.join(hooksDir(cwd), 'state', name)); } catch (e) { /* ignore */ }
}

/** Current git branch for `cwd`, or null if not resolvable (never throws). */
function gitBranch(cwd) {
  try {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 3000 });
    if (r.status === 0) return r.stdout.trim();
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * Tail the last `maxBytes` of a (possibly huge) transcript JSONL file and
 * return only the real, top-level user-typed prompt strings (not tool
 * results, not assistant turns) — the thing a human actually typed.
 */
function recentUserPrompts(transcriptPath, maxBytes = 400000, maxCount = 300) {
  const out = [];
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return out;
  try {
    const stat = fs.statSync(transcriptPath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(transcriptPath, 'r');
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (e) { continue; }
      if (obj && obj.type === 'user' && obj.message && typeof obj.message.content === 'string') {
        out.push(obj.message.content);
        if (out.length >= maxCount) break;
      }
    }
  } catch (e) { /* best effort */ }
  return out;
}

function containsPhrase(prompts, regex) {
  return prompts.some((p) => regex.test(p));
}

/** Send an exit-2 blocking decision (the ONLY exit code that truly blocks). */
function deny(reason) {
  process.stderr.write(reason + '\n');
  process.exit(2);
}

/** Exit 0, no decision — tool proceeds normally through the regular permission flow. */
function allowSilently() {
  process.exit(0);
}

/** Exit 0 with an explicit allow + optional context note (visible, not blocking). */
function allowWithNote(note) {
  const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
  if (note) out.hookSpecificOutput.additionalContext = note;
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

module.exports = {
  readStdinJSON, hooksDir, ensureDir, appendLog, heartbeat, readState, writeState,
  clearState, gitBranch, recentUserPrompts, containsPhrase, deny, allowSilently, allowWithNote,
};
