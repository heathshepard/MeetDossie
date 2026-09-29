#!/usr/bin/env node
'use strict';
/**
 * Injects the real current date/time into Cole's context automatically, so
 * no agent ever has to run `date` manually or be told the date by Heath.
 *
 * Wired to TWO hook events in .claude/settings.json:
 *   - SessionStart     — fires once when a session begins/resumes/clears/
 *                        un-compacts, so context is fresh from turn one.
 *   - UserPromptSubmit — fires on EVERY user message, which is what actually
 *                        matters for long sessions. This session itself ran
 *                        many hours and crossed a real date rollover
 *                        (08-25 -> 08-26) mid-conversation; a SessionStart-
 *                        only hook would have gone stale the moment the
 *                        clock ticked over. UserPromptSubmit re-fires the
 *                        stamp on every single turn, so it can never be more
 *                        than one prompt out of date, and it also carries
 *                        clock time (hour/minute), which the environment's
 *                        own `currentDate` field does not — the exact gap
 *                        that caused the "tonight" timing claim to slip.
 *
 * Verified against the installed Claude Code binary (v2.1.245,
 * /home/heath/.local/share/claude/versions/2.1.245) via `strings`:
 *   - Both SessionStart and UserPromptSubmit are real hook events
 *     ("### Hook Events" table embedded in the binary's own docs).
 *   - Only "type":"command" is valid for these two events — "prompt" and
 *     "agent" hook types are documented as "Only available for tool events:
 *     PreToolUse, PostToolUse, PermissionRequest." So this must be (and is)
 *     a command hook, same as the PreCompact handoff hook.
 *   - Output contract confirmed in the binary's own bundled code: a hook's
 *     stdout JSON field `hookSpecificOutput.additionalContext` is collected
 *     into `additionalContexts` and pushed into the transcript as a
 *     `hook_additional_context` message tagged with the firing hook's event
 *     name — i.e. this is really injected into model-visible context, not
 *     just logged.
 *
 * Fast and side-effect-free: only reads the current time and prints JSON.
 * Never blocks the prompt/session — always exits 0.
 */
const fs = require('fs');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf-8');
  } catch (e) {
    return '';
  }
}

let input = {};
try {
  input = JSON.parse(readStdin() || '{}');
} catch (e) {
  // Malformed/empty stdin — still fine, we don't depend on any input field.
}

const hookEventName = input.hook_event_name || 'UserPromptSubmit';

const now = new Date();

// Central Time is Heath's timezone (San Antonio, TX). Show both local wall
// clock and an unambiguous ISO/UTC form so no agent has to guess offsets.
const centralFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  weekday: 'long',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
  timeZoneName: 'short',
});

const centralStr = centralFormatter.format(now);
const isoStr = now.toISOString();

const contextLine =
  `Current real-world date/time: ${centralStr} ` +
  `(ISO/UTC: ${isoStr}). This is ground truth — trust it over any stale ` +
  `date shown elsewhere in context, and never say "tonight"/"this morning"/ ` +
  `"just now" without checking it first.`;

const output = {
  hookSpecificOutput: {
    hookEventName,
    additionalContext: contextLine,
  },
};

process.stdout.write(JSON.stringify(output));
process.exit(0);
