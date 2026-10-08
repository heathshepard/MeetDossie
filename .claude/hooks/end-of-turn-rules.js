#!/usr/bin/env node
'use strict';
/**
 * UserPromptSubmit hook — injects Heath's 5 hardest, most-repeated rules as
 * a small fixed block via `additionalContext`, on every turn. Deliberately
 * NOT semantic retrieval (Cole's 2026-09-28 correction, backed by SysBench:
 * style/format instructions decay first across turns, and OpenAI's own
 * guidance is that models favor instructions placed closer to the end of
 * the prompt — so a fixed, tiny, always-recent block beats a bigger
 * "smarter" system that competes with itself for attention).
 *
 * Also doubles as the empirical proof that UserPromptSubmit fires inside a
 * git worktree session: every firing appends one line to
 * .claude/hooks/logs/end-of-turn-rules.log (cwd-scoped) and touches a
 * heartbeat file. If that log is empty after a real prompt, this hook did
 * not fire — check that before trusting anything else in this file.
 *
 * Budget: this file does file IO only (no model calls, no network), and the
 * injected block is fixed text, so it costs one read + one append, well
 * under a millisecond of actual work.
 */
const fs = require('fs');
const path = require('path');
const util = require(path.join(__dirname, 'lib', 'hook-utils.js'));

const HEARTBEAT_FILE = 'end-of-turn-rules-heartbeat.txt';
const LOG_FILE = 'end-of-turn-rules.log';

// Heath's five, in priority order (2026-09-28). Edit here, not per-project —
// this is the one place these should live so they don't drift out of sync
// with CLAUDE.md Section 0 / 17.
const RULES_BLOCK = `[end-of-turn rules — read this last, it overrides drift from earlier in context]
1. Replies are 3-6 lines. Lead with what changed and what Heath must do. No agent-report relay.
2. Never let a schedule cause a miss — fire it manually in the same turn.
3. Verify before asserting; say what you personally confirmed vs. what an agent reported.
4. Never fabricate a story, number, customer event, or product capability.
5. No episode N of a series ships to a surface where episode N-1 hasn't.`;

// Live clock, computed fresh every invocation — never trust a remembered
// date from earlier context. Fixed to America/Chicago regardless of the
// host system's TZ env var, since this runs under whatever shell invoked it.
function computeNowLine() {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    });
    const parts = dtf.formatToParts(new Date());
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    let hour = map.hour;
    if (hour === '24') hour = '00'; // some ICU builds emit "24" for midnight under hour12:false
    return `NOW: ${map.weekday} ${map.year}-${map.month}-${map.day} ${hour}:${map.minute} ${map.timeZoneName} (America/Chicago) — all day/time claims use this, never a remembered date.`;
  } catch (e) {
    return `NOW: unavailable (${e.message}) — do not guess the date/time.`;
  }
}

function main() {
  let input = {};
  try {
    input = util.readStdinJSON();
  } catch (e) {
    // Can't read our own stdin — still emit the rules block so the turn
    // isn't silently missing it, just skip the cwd-scoped logging below.
    process.stdout.write(computeNowLine() + '\n' + RULES_BLOCK);
    return;
  }

  const cwd = input.cwd || process.cwd();

  try {
    util.heartbeat(cwd, HEARTBEAT_FILE);
    util.appendLog(cwd, LOG_FILE, {
      level: 'FIRED',
      session_id: input.session_id,
      prompt_len: (input.prompt_text || '').length,
    });
  } catch (e) {
    // Logging failed but the rules block itself must still reach Claude —
    // this is exactly the "never silently empty" requirement.
    process.stdout.write(computeNowLine() + '\n' + RULES_BLOCK + `\n[end-of-turn-rules: logging failed (${e.message}) — investigate .claude/hooks/logs/${LOG_FILE}]`);
    return;
  }

  process.stdout.write(computeNowLine() + '\n' + RULES_BLOCK);
}

try {
  main();
} catch (e) {
  // Absolute last resort — still surface something rather than nothing.
  process.stdout.write(computeNowLine() + '\n' + RULES_BLOCK + `\n[end-of-turn-rules: internal error (${e.message})]`);
}
process.exit(0);
