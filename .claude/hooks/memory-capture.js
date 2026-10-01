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
 * single assistant turn.
 *
 * ===========================================================================
 * 2026-10-01 REBUILD — read this before touching the gate logic below.
 * ===========================================================================
 * The first version of this hook (merged `d358dc54`, GOLD-2026-09-28-v3)
 * gated per-`session_id`. Within ~2.5 minutes, 5 DISTINCT session_ids fired
 * it from a single active worktree — every subagent/worktree-internal
 * dispatch gets its own session_id in this environment, so a per-session
 * lock bounded nothing across them — 2 concurrent `claude -p` processes had
 * to be `kill -9`'d, and hotfix `e7c891c8` unwired this hook from
 * settings.json entirely. See memory/memory-capture-hook-token-drain-
 * 2026-09-28.md and memory/feedback_memory-capture-cost-control-
 * requirements.md for the full incident and Heath's exact rebuild spec.
 *
 * The fix: `lib.acquireCaptureSlot()` is now a MACHINE-WIDE (per-cwd, not
 * per-session) gate — rate limit, then daily ceiling, then lock — sitting in
 * front of EVERYTHING, including the decision of whether this is a report
 * or live run. Nothing below this gate runs until a slot is granted.
 * Defaults (30 min rate limit, 12/day ceiling, 3 min stale-lock) live in
 * GUARD_CONFIG_DEFAULTS and are overridable via `.claude/hooks/guard-
 * config.json`'s `memory_capture` key.
 *
 * Defaults to REPORT MODE: now genuinely cheap — a single `fs.statSync` to
 * report the pending byte delta, NO transcript parsing, NO `claude -p`
 * spawn, nothing written anywhere but a one-line log. Set
 * MEMORY_CAPTURE_LIVE=1 for the real (expensive, gated, rate-limited)
 * extraction + write path.
 *
 * Never blocks its own event: PreCompact and SessionEnd both always exit 0.
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

// SessionEnd's real budget is much smaller than PreCompact's (see file
// header + settings.json) — measured completions at a 25k-char excerpt ran
// 46-96s, comfortably inside a 60s-configured hook, whereas 150k chars ran
// 46-180s and once hit a 100s timeout that turned out to be real completion
// running long, not a hang.
const SESSION_END_MAX_EXCERPT_CHARS = 25000;

// TEST-ONLY escape hatch, never set in settings.json or any real deployment:
// lets the concurrency-gate proof (see scripts under this file's PR) launch
// many real concurrent OS processes without spending any real `claude -p`
// cost, while every gate check still runs for real. If this is ever set
// outside a deliberate test harness, the hook is not doing real extraction.
const FAKE_SPAWN = process.env.MEMORY_CAPTURE_FAKE_SPAWN === '1';

function watermarkKey(sessionId) {
  return `memory-capture-watermark-${(sessionId || 'unknown').slice(0, 12)}.json`;
}

function readWatermark(cwd, sessionId) {
  const raw = util.readState(cwd, watermarkKey(sessionId));
  if (!raw) return { offset: 0, lastRunAt: 0 };
  try { return JSON.parse(raw); } catch (e) { return { offset: 0, lastRunAt: 0 }; }
}

function writeWatermark(cwd, sessionId, state) {
  util.writeState(cwd, watermarkKey(sessionId), JSON.stringify(state));
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
  const now = Date.now();

  util.heartbeat(cwd, 'memory-capture-heartbeat.txt');

  // ---- MACHINE-WIDE GATE — see file header. Applies before ANYTHING else,
  // including report-mode's cheap path, and uniformly across every
  // session_id firing from this cwd. ----
  const config = lib.readMemoryCaptureConfig(cwd);
  const slot = lib.acquireCaptureSlot(cwd, now, config);
  if (!slot.allowed) {
    util.appendLog(cwd, LOG_FILE, {
      level: `SKIP_${slot.reason}`,
      event,
      trigger,
      sessionId: sessionId.slice(0, 12),
      config,
      detail: slot.detail,
    });
    process.exit(0);
  }

  try {
    runCapture({ cwd, event, trigger, sessionId, transcriptPath, live, now });
  } finally {
    lib.releaseCaptureSlot(cwd);
  }
}

function runCapture({ cwd, event, trigger, sessionId, transcriptPath, live, now }) {
  const watermark = readWatermark(cwd, sessionId);

  if (!live) {
    // ---- REPORT MODE: genuinely cheap. One stat() call, no transcript
    // parse, no claude -p spawn, no write anywhere but this log line. This
    // is the direct fix for "report mode paid full cost" in the incident —
    // previously MEMORY_CAPTURE_LIVE only gated the final write, so a dry
    // run cost exactly as much as a real one. ----
    let deltaBytes = 0;
    let statOk = true;
    try {
      const size = fs.statSync(transcriptPath).size;
      deltaBytes = Math.max(0, size - (watermark.offset || 0));
    } catch (e) {
      statOk = false;
    }
    util.appendLog(cwd, LOG_FILE, {
      level: 'REPORT_MODE_SKIP_EXTRACT',
      event,
      trigger,
      sessionId: sessionId.slice(0, 12),
      deltaBytes,
      statOk,
      msg: 'would have extracted — report mode does not spawn claude -p; set MEMORY_CAPTURE_LIVE=1 for a real run',
    });
    // Deliberately does NOT advance the watermark: nothing was processed, so
    // there is nothing to mark done. The first live run picks up the full
    // backlog via the existing oldest-first, no-loss truncation.
    return;
  }

  // ---- LIVE MODE from here down: the gate above already granted a slot. ----
  const maxExcerptChars = event === 'SessionEnd' ? SESSION_END_MAX_EXCERPT_CHARS : lib.MAX_EXCERPT_CHARS;
  const { excerpt, newOffset, hadContent, truncated, fullChars } = lib.extractNewExcerpt(transcriptPath, watermark.offset, maxExcerptChars);
  if (!hadContent) {
    util.appendLog(cwd, LOG_FILE, { level: 'SKIP_NO_NEW_CONTENT', event, trigger });
    writeWatermark(cwd, sessionId, { offset: newOffset, lastRunAt: now });
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

  const existingFilenames = lib.readExistingMemoryFilenames();
  let candidates = [];
  let extractError = null;

  if (FAKE_SPAWN) {
    // TEST-ONLY path — see FAKE_SPAWN comment above. Proves the gate without
    // spending a real claude -p call: simulates real spawn latency (so a
    // concurrency test actually has a window to race in) and returns a
    // fixed, obviously-fake candidate that validateAndFilterCandidates will
    // reject on name/content, so it can never accidentally land in real
    // memory even if a test forgets to use report mode.
    const start = Date.now();
    while (Date.now() - start < 1500) { /* busy-wait to simulate spawn latency */ }
    candidates = [{ category: 'fact', action: 'new', name: '__fake_spawn_test_candidate__', description: 'FAKE_SPAWN test artifact, must never be accepted', body_markdown: 'test', why: 'test' }];
  } else {
    try { fs.mkdirSync(OUT_FILE_DIR, { recursive: true }); } catch (e) { /* ignore */ }
    const outFile = path.join(OUT_FILE_DIR, `${sessionId.slice(0, 12)}-${Date.now()}.json`);

    const memoryIndexText = lib.readMemoryIndexText();
    const claudeMdText = lib.readClaudeMdText();
    const sessionDate = new Date().toISOString().slice(0, 10);

    const prompt = lib.buildExtractionPrompt({
      excerpt, memoryIndexText, existingFilenames, claudeMdText, outFile, sessionDate,
    });

    // Measured for real against a 150k-char excerpt + ~200KB total prompt:
    // completions ran 46s-180s. PreCompact's settings.json timeout is 240s
    // to match; this internal spawn timeout stays a little under that so
    // the hook can still log an ERROR and release its slot cleanly instead
    // of being hard-killed by Claude Code's own hook timeout.
    const timeoutMs = event === 'SessionEnd' ? 45000 : 220000;

    const result = lib.runExtraction({ cwd, prompt, outFile, timeoutMs });
    candidates = result.candidates;
    extractError = result.error;
    try { fs.unlinkSync(outFile); } catch (e) { /* best effort cleanup */ }
  }

  if (extractError) {
    util.appendLog(cwd, LOG_FILE, { level: 'ERROR', event, msg: extractError });
    // Do NOT advance the watermark on a failed extraction — retry the same
    // delta next time instead of silently losing it. The global rate limit
    // (not the watermark) is what prevents a tight retry loop now.
    return;
  }

  const { accepted, rejected } = lib.validateAndFilterCandidates(candidates, { existingFilenames });

  const appliedNew = lib.applyCaptures(accepted, { live, sessionId });
  const indexResult = lib.updateMemoryIndex(appliedNew, { live });

  const logPath = lib.writeCaptureSessionLog({
    sessionId, event, trigger, live, accepted, rejected, indexResult, error: null, truncated, fullChars,
  });

  util.appendLog(cwd, LOG_FILE, {
    level: 'RUN',
    event,
    trigger,
    live,
    fakeSpawn: FAKE_SPAWN,
    candidatesRaw: Array.isArray(candidates) ? candidates.length : 0,
    accepted: accepted.length,
    rejected: rejected.length,
    indexAdded: indexResult.added,
    indexPending: indexResult.pending,
    indexCapHit: indexResult.capHit,
    sessionLog: logPath,
  });

  writeWatermark(cwd, sessionId, { offset: newOffset, lastRunAt: now });
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
