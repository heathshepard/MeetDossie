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
 * Defaults to REPORT MODE (MEMORY_CAPTURE_LIVE unset): logs that there is
 * new content and that it WOULD have extracted, but does not spawn the
 * `claude -p` extraction at all and writes nothing. Set MEMORY_CAPTURE_LIVE=1
 * to actually extract and write. This is a deliberate change from the
 * original spec (which had report mode run the full extraction and only
 * gate the write) — that version made report mode cost the same as live,
 * which is exactly backwards for a mode whose whole purpose is to be cheap.
 * See lib/capture-lock.js for the machine-wide lock + rate limiter that
 * gates the real (live-mode-only) spawn.
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
const captureLock = require(path.join(__dirname, 'lib', 'capture-lock.js'));

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
// Cheap, LOCAL, per-session backstop only — avoids redundant excerpt reads
// when the SAME session_id fires repeatedly in a tight window (SessionEnd
// has been observed firing every 10-50s in a busy multi-agent session).
// This is NOT the concurrency-safety mechanism (a per-session anything
// can't be — see capture-lock.js header for why) — that job now belongs
// entirely to the machine-wide lock + rate limiter in lib/capture-lock.js,
// checked in runCapture() immediately before the expensive spawn.
const MIN_RERUN_INTERVAL_MS = 5 * 60 * 1000; // throttle back-to-back firings, same session only

function watermarkKey(sessionId) {
  return `memory-capture-watermark-${(sessionId || 'unknown').slice(0, 12)}.json`;
}

function readWatermark(cwd, sessionId) {
  const raw = util.readState(cwd, watermarkKey(sessionId));
  if (!raw) return { offset: 0, lastRunAt: 0, lastAttemptAt: 0 };
  try { return JSON.parse(raw); } catch (e) { return { offset: 0, lastRunAt: 0, lastAttemptAt: 0 }; }
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

  util.heartbeat(cwd, 'memory-capture-heartbeat.txt');

  const watermark = readWatermark(cwd, sessionId);
  const sinceLastAttemptMs = Date.now() - (watermark.lastAttemptAt || watermark.lastRunAt || 0);

  // Cheap local backstop covers every trigger EXCEPT a manual /compact
  // (a deliberate one-off user action worth honoring immediately). Measured
  // against lastAttemptAt (set below) rather than lastRunAt (only set on
  // success) — a run that errors or times out still counts as an attempt,
  // otherwise a failing extraction retries in a tight loop instead of
  // backing off. This does NOT provide concurrency safety by itself (see
  // capture-lock.js header) — that's the machine-wide gate checked inside
  // runCapture(), right before the expensive spawn.
  if (trigger !== 'manual' && sinceLastAttemptMs < MIN_RERUN_INTERVAL_MS) {
    util.appendLog(cwd, LOG_FILE, { level: 'SKIP_THROTTLE', event, trigger, sinceLastAttemptMs });
    process.exit(0);
  }

  // Record the attempt immediately, before any slow work, so a second
  // overlapping firing for this SAME session that arrives before this one
  // finishes sees a fresh lastAttemptAt and backs off via the throttle
  // above too.
  writeWatermark(cwd, sessionId, { ...watermark, lastAttemptAt: Date.now() });

  runCapture({ cwd, event, trigger, sessionId, transcriptPath, live, watermark });
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

  // REPORT MODE: genuinely cheap. There IS new content, but report mode
  // never spawns `claude -p` — log that it would have and stop. Deliberately
  // does NOT touch capture-lock.js at all (no lock acquire, no rate-limit or
  // daily-cap consumption) — that ledger exists to bound spawn cost, and
  // report mode has no spawn cost to bound. Offset is NOT advanced, so this
  // same delta is what live mode (or a future firing) will see.
  if (!live) {
    util.appendLog(cwd, LOG_FILE, {
      level: 'REPORT_WOULD_EXTRACT',
      event,
      trigger,
      excerptChars: excerpt.length,
      truncated,
    });
    return;
  }

  // LIVE MODE from here on — this is the expensive path. Gate it globally
  // before spawning anything. gate() itself logs the reason (to
  // capture-lock.js's REASON_LOG, the one file for "why did/didn't capture
  // run") on every outcome, pass or skip.
  const gateResult = captureLock.gate({ event, sessionId });
  if (!gateResult.allowed) {
    util.appendLog(cwd, LOG_FILE, { level: 'SKIP_GATE', event, trigger, reason: gateResult.reason });
    // Do NOT advance offset — this delta is still pending. The next firing
    // (this session or any other) picks it up once the gate opens again.
    return;
  }

  try {
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

    const appliedNew = lib.applyCaptures(accepted, { live: true, sessionId });
    const indexResult = lib.updateMemoryIndex(appliedNew, { live: true });

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
  } finally {
    gateResult.release();
  }
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
