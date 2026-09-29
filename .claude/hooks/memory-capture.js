#!/usr/bin/env node
'use strict';
/**
 * Memory-capture hook — PreCompact and SessionEnd.
 *
 * WHY these two events: PreCompact fires before every compaction (manual
 * /compact or automatic), which is exactly where uncaptured corrections get
 * lost — and on a long session it fires repeatedly, not just once, so this
 * hook gets many chances through the day instead of one at the very end.
 * SessionEnd is the final catch-net for whatever happened since the last
 * PreCompact (fires on normal exit/`/clear`/logout — NOT on crash, per
 * Claude Code docs). Stop was deliberately NOT wired: it fires on every
 * single assistant turn, and spawning a full extraction turn that often
 * would blow through Max-plan usage for near-zero incremental recall (see
 * memory/feedback_conserve-max-plan-usage.md) for material this hook will
 * catch a few minutes later at the next PreCompact anyway.
 *
 * Defaults to REPORT MODE: extracts, filters, and logs what it would write,
 * writes nothing to any memory file. Set MEMORY_CAPTURE_LIVE=1 to write for
 * real. This is intentional per the build spec — nothing here writes
 * autonomously until a real session's report-mode output has been read.
 *
 * Never blocks its own event: PreCompact and SessionEnd both always exit 0.
 * SessionEnd additionally has only a 1.5s DEFAULT shared timeout budget
 * across all SessionEnd hooks (raised to this hook's configured `timeout`,
 * capped at 60s, per Claude Code docs) — so the excerpt cap and a same-model
 * `claude -p` call are both sized to fit inside that window on the common
 * case (small delta, because PreCompact already ran earlier in the session).
 */
const fs = require('fs');
const path = require('path');
const util = require(path.join(__dirname, 'lib', 'hook-utils.js'));
const lib = require(path.join(__dirname, 'lib', 'memory-capture-lib.js'));

const LOG_FILE = 'memory-capture.log'; // repo-local, gitignored, METADATA ONLY — never content
// MUST be inside the repo AND outside .claude/: the extraction sub-turn's
// Write tool is only auto-approved by this repo's own .claude/settings.json
// (permissions.defaultMode=acceptEdits), which does not extend to /tmp — and
// separately, Claude Code treats anything under .claude/ as a "sensitive"
// path and blocks Write there even under acceptEdits. Both found the hard
// way: a /tmp path and a .claude/hooks/logs/ path each let the sub-turn
// correctly extract real candidates and then silently fail to save them
// ("that path is treated as a sensitive file") — precompact-handoff.js
// dodges this by writing HANDOFF.md at repo ROOT, so this does the same.
// See .gitignore for why this directory must never be committed.
const REPO_ROOT = path.resolve(__dirname, '..', '..'); // .claude/hooks -> repo root
const OUT_FILE_DIR = path.join(REPO_ROOT, '.memory-capture-tmp');
const MIN_RERUN_INTERVAL_MS = 5 * 60 * 1000; // throttle back-to-back firings
const LOCK_STALE_MS = 3 * 60 * 1000; // a crashed/killed run should not jam this forever

function watermarkKey(sessionId) {
  return `memory-capture-watermark-${(sessionId || 'unknown').slice(0, 12)}.json`;
}

function lockKey(sessionId) {
  return `memory-capture-lock-${(sessionId || 'unknown').slice(0, 12)}.txt`;
}

function readWatermark(cwd, sessionId) {
  const raw = util.readState(cwd, watermarkKey(sessionId));
  if (!raw) return { offset: 0, lastRunAt: 0, lastAttemptAt: 0 };
  try { return JSON.parse(raw); } catch (e) { return { offset: 0, lastRunAt: 0, lastAttemptAt: 0 }; }
}

function writeWatermark(cwd, sessionId, state) {
  util.writeState(cwd, watermarkKey(sessionId), JSON.stringify(state));
}

/**
 * Simple mutex so two overlapping firings for the same session (observed in
 * practice: this environment fires SessionEnd every 10-50s during a busy
 * multi-agent/background-dispatch session, nothing like the "session truly
 * ends" cadence the docs describe for an interactive terminal) can't both
 * spawn a `claude -p` extraction at once. A stale lock (owner crashed/timed
 * out) is treated as free after LOCK_STALE_MS rather than jamming forever.
 */
function tryAcquireLock(cwd, sessionId) {
  const key = lockKey(sessionId);
  const existing = util.readState(cwd, key);
  if (existing) {
    const age = Date.now() - Number(existing || 0);
    if (Number.isFinite(age) && age < LOCK_STALE_MS) return false;
  }
  util.writeState(cwd, key, String(Date.now()));
  return true;
}

function releaseLock(cwd, sessionId) {
  util.clearState(cwd, lockKey(sessionId));
}

function main() {
  let input = {};
  try {
    input = util.readStdinJSON();
  } catch (e) {
    util.appendLog(process.cwd(), LOG_FILE, { level: 'ERROR', msg: `bad stdin JSON: ${e.message}` });
    process.exit(0);
  }

  const cwd = input.cwd || process.cwd();
  const event = input.hook_event_name || 'unknown';
  const sessionId = input.session_id || 'unknown';
  const trigger = input.trigger || input.reason || 'unknown'; // PreCompact:trigger, SessionEnd:reason
  const transcriptPath = input.transcript_path || '';
  const live = process.env.MEMORY_CAPTURE_LIVE === '1';

  util.heartbeat(cwd, 'memory-capture-heartbeat.txt');

  const watermark = readWatermark(cwd, sessionId);
  const sinceLastAttemptMs = Date.now() - (watermark.lastAttemptAt || watermark.lastRunAt || 0);

  // Throttle covers every trigger EXCEPT a manual /compact, which is a
  // deliberate one-off user action worth honoring immediately. Measured
  // against lastAttemptAt (set below, BEFORE the spawn) rather than
  // lastRunAt (only set on success) — a run that errors or times out still
  // counts as an attempt, otherwise a failing extraction retries in a tight
  // loop instead of backing off. See LOCK_STALE_MS / tryAcquireLock for the
  // companion fix: this throttle alone doesn't stop two firings that land
  // within the same instant from both slipping through before either has
  // written lastAttemptAt.
  if (trigger !== 'manual' && sinceLastAttemptMs < MIN_RERUN_INTERVAL_MS) {
    util.appendLog(cwd, LOG_FILE, { level: 'SKIP_THROTTLE', event, trigger, sinceLastAttemptMs });
    process.exit(0);
  }

  if (!tryAcquireLock(cwd, sessionId)) {
    util.appendLog(cwd, LOG_FILE, { level: 'SKIP_LOCKED', event, trigger });
    process.exit(0);
  }

  // Record the attempt immediately, before the (slow) extraction spawn, so a
  // second overlapping firing that arrives before this one finishes sees a
  // fresh lastAttemptAt and backs off via the throttle above too.
  writeWatermark(cwd, sessionId, { ...watermark, lastAttemptAt: Date.now() });

  // Everything below holds the lock — always release it, on every exit path,
  // including an unexpected throw. A held lock past LOCK_STALE_MS free-fixes
  // itself, but there's no reason to make the next firing wait 3 minutes for
  // a run that actually finished cleanly.
  try {
    runCapture({ cwd, event, trigger, sessionId, transcriptPath, live, watermark });
  } finally {
    releaseLock(cwd, sessionId);
  }
}

// SessionEnd's real budget is much smaller than PreCompact's (see file
// header + settings.json) — measured completions at a 25k-char excerpt ran
// 46-96s, comfortably inside a 60s-configured hook, whereas 150k chars ran
// 46-180s and once hit a 100s timeout that turned out to be real completion
// running long, not a hang. Better to guarantee SOME candidates come back
// from SessionEnd than to gamble the whole run on a budget it can't meet.
const SESSION_END_MAX_EXCERPT_CHARS = 25000;

function runCapture({ cwd, event, trigger, sessionId, transcriptPath, live, watermark }) {
  const maxExcerptChars = event === 'SessionEnd' ? SESSION_END_MAX_EXCERPT_CHARS : lib.MAX_EXCERPT_CHARS;
  const { excerpt, newOffset, hadContent, truncated, fullChars } = lib.extractNewExcerpt(transcriptPath, watermark.offset, maxExcerptChars);
  if (!hadContent) {
    util.appendLog(cwd, LOG_FILE, { level: 'SKIP_NO_NEW_CONTENT', event, trigger });
    writeWatermark(cwd, sessionId, { offset: newOffset, lastRunAt: Date.now(), lastAttemptAt: Date.now() });
    return;
  }
  if (truncated) {
    // Loud on purpose — see MAX_EXCERPT_CHARS comment in memory-capture-lib.js.
    util.appendLog(cwd, LOG_FILE, {
      level: 'WARN_TRUNCATED',
      event,
      msg: `delta was ${fullChars} chars, only sent the oldest ${maxExcerptChars} for extraction this run — the newer remainder is deferred to the next firing, not lost`,
    });
  }

  try { fs.mkdirSync(OUT_FILE_DIR, { recursive: true }); } catch (e) { /* ignore */ }
  const outFile = path.join(OUT_FILE_DIR, `${sessionId.slice(0, 12)}-${Date.now()}.json`);

  const memoryIndexText = lib.readMemoryIndexText();
  const existingFilenames = lib.readExistingMemoryFilenames();
  const claudeMdText = lib.readClaudeMdText();
  const sessionDate = new Date().toISOString().slice(0, 10);

  const prompt = lib.buildExtractionPrompt({
    excerpt, memoryIndexText, existingFilenames, claudeMdText, outFile, sessionDate,
  });

  // Measured for real against a 150k-char excerpt + ~200KB total prompt
  // (CLAUDE.md + MEMORY.md index + excerpt): completions ran 46s-180s, one
  // run hit a 100s cap that turned out to be a real completion, not a hang.
  // PreCompact's settings.json timeout was raised to 240s to match (see
  // settings.json) — this internal spawn timeout stays a little under that
  // so the hook can still log an ERROR and release its lock cleanly instead
  // of being hard-killed by Claude Code's own hook timeout. SessionEnd is
  // capped by the shared-budget rule in the file header, so it additionally
  // gets a smaller excerpt cap (see maxExcerptChars below), not just a
  // shorter spawn timeout.
  const timeoutMs = event === 'SessionEnd' ? 45000 : 220000;

  const { candidates, error: extractError } = lib.runExtraction({ cwd, prompt, outFile, timeoutMs });
  try { fs.unlinkSync(outFile); } catch (e) { /* best effort cleanup */ }

  if (extractError) {
    util.appendLog(cwd, LOG_FILE, { level: 'ERROR', event, msg: extractError });
    // Do NOT advance the watermark's offset on a failed extraction — retry
    // the same delta next time instead of silently losing it. lastAttemptAt
    // was already written above, so the throttle still backs this off.
    return;
  }

  const { accepted, rejected } = lib.validateAndFilterCandidates(candidates, { existingFilenames });

  const appliedNew = live ? lib.applyCaptures(accepted, { live, sessionId }) : lib.applyCaptures(accepted, { live: false, sessionId });
  const indexResult = lib.updateMemoryIndex(appliedNew, { live });

  const logPath = lib.writeCaptureSessionLog({
    sessionId, event, trigger, live, accepted, rejected, indexResult, error: null, truncated, fullChars,
  });

  util.appendLog(cwd, LOG_FILE, {
    level: 'RUN',
    event,
    trigger,
    live,
    candidatesRaw: Array.isArray(candidates) ? candidates.length : 0,
    accepted: accepted.length,
    rejected: rejected.length,
    indexAdded: indexResult.added,
    indexPending: indexResult.pending,
    indexCapHit: indexResult.capHit,
    sessionLog: logPath,
  });

  writeWatermark(cwd, sessionId, { offset: newOffset, lastRunAt: Date.now(), lastAttemptAt: Date.now() });
}

try {
  main();
} catch (e) {
  try {
    util.appendLog(process.cwd(), LOG_FILE, { level: 'FATAL', msg: e.message, stack: (e.stack || '').slice(0, 2000) });
  } catch (e2) { /* nowhere left to report this */ }
}
// Never block PreCompact or SessionEnd on this hook's outcome.
process.exit(0);
