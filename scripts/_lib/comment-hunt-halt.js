'use strict';

// scripts/_lib/comment-hunt-halt.js
//
// CIRCUIT BREAKER for the daily comment-opportunity pipeline (and, sharing
// the same file/profile, the group-post queues). The entire distribution
// strategy runs through ONE Facebook profile that was shadowbanned in June
// from automated bursts — losing it ends everything.
//
// GLOBAL vs GROUP scope (added 2026-09-14, after a single moderator in one
// TC-only group halted ALL distribution for three days over one removed
// comment):
//   - A GLOBAL halt stops every group / every pipeline sharing this file.
//     Reserved for account-level signals: a Facebook checkpoint, a
//     login redirect, an account restriction, or a comment removed in 2+
//     DISTINCT groups (a pattern, not a one-off strict moderator).
//   - A GROUP halt stops only that one group. A single removed comment in
//     one group is a moderation call by that group, not evidence the
//     account is at risk — it pauses that group and nothing else.
//   - Callers get this by passing `{ scope: 'group', group: '<name>' }` in
//     detail to setHalt(). Omitting `scope` (or passing anything other than
//     'group') is GLOBAL — this is the pre-2026-09-14 default and every
//     existing caller that doesn't pass `scope` keeps behaving exactly as
//     it did before this file changed.
//   - Reaching 2 DISTINCT groups currently paused (via the group-scoped
//     path) auto-escalates to a global halt — same file, so
//     fb-group5-post-queue.js / fb-listing-group-post-queue.js also stop,
//     which is correct: a removal pattern across groups is an account-level
//     signal, not a per-group one.
//
// Halt triggers (written by fb-comment-hunt-daily.js / fb-comment-opp-poster.js
// / fb-group5-post-queue.js / fb-listing-group-post-queue.js):
//   - a previously posted comment is no longer present in its thread,
//     removed by a mod (GROUP scope — see above)
//   - Facebook redirects to login / checkpoint (temp block / logged out) — GLOBAL
//   - a submitted comment fails to render back on re-read (verify failure) — GLOBAL
//   - a group-post queue run does not confirm success — GLOBAL
//
// While GLOBALLY halted: nothing scans, nothing posts, anywhere. While a
// single GROUP is halted: that group is skipped; every other group and
// every other pipeline keeps running.
//
// Clear a global halt (does NOT touch any group-level pauses):
//   node scripts/fb-comment-opp-poster.js --clear-halt
// Clear one group's pause (does NOT touch the global halt or other groups):
//   node scripts/fb-comment-opp-poster.js --clear-halt --group "<group name>"
// Nuclear option — clear everything, global + every group pause:
//   node scripts/fb-comment-opp-poster.js --clear-halt --all
// (or edit/delete scripts/.comment-hunt-halt.json by hand).
//
// Owner: Carter, 2026-09-08 / rescoped per-group 2026-09-14

const fs = require('fs');
const path = require('path');

// COMMENT_HUNT_HALT_FILE lets regression tests point this module at a
// scratch file instead of the real production halt state. Unset in
// production — HALT_FILE resolves to the same path it always has.
const HALT_FILE = process.env.COMMENT_HUNT_HALT_FILE || path.join(__dirname, '..', '.comment-hunt-halt.json');

/**
 * Internal: load { global, groups } from disk. Handles two legacy shapes so
 * an old halt file left on disk never fails open:
 *   - missing file -> { global: null, groups: {} }
 *   - pre-2026-09-14 flat shape ({ reason, halted_at, ... }, no `global`/
 *     `groups` keys) -> treated as an existing GLOBAL halt
 *   - corrupt/unreadable file -> fail SAFE: a synthetic global halt, never
 *     fail open
 */
function loadState() {
  try {
    if (!fs.existsSync(HALT_FILE)) return { global: null, groups: {} };
    const raw = JSON.parse(fs.readFileSync(HALT_FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      if (raw.global !== undefined || raw.groups !== undefined) {
        return { global: raw.global || null, groups: raw.groups || {} };
      }
      // Legacy flat shape: { reason, halted_at, ... } === an existing global halt.
      if (raw.reason || raw.halted_at) {
        return { global: raw, groups: {} };
      }
    }
    return { global: null, groups: {} };
  } catch (e) {
    // Corrupt halt file = still halted. Fail SAFE, never fail open.
    return { global: { reason: `halt file unreadable: ${e.message}`, halted_at: null }, groups: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(HALT_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/** Global halt entry, or null. */
function getGlobalHalt() {
  return loadState().global;
}

/** One group's halt entry, or null. Does NOT fall back to global. */
function getGroupHalt(group) {
  if (!group) return null;
  const state = loadState();
  return state.groups[group] || null;
}

/** All currently-paused groups, keyed by group name. */
function listPausedGroups() {
  return loadState().groups;
}

/**
 * Effective halt for a caller: global halt (if any) always wins, otherwise
 * the named group's own halt (if any), otherwise null.
 *   getHalt()        -> global halt only (back-compat: every pre-2026-09-14
 *                        caller that doesn't pass a group)
 *   getHalt('name')  -> global halt, else that group's halt
 */
function getHalt(group) {
  const state = loadState();
  if (state.global) return state.global;
  if (group && state.groups[group]) return state.groups[group];
  return null;
}

function isHalted(group) {
  return getHalt(group) !== null;
}

/**
 * setHalt(reason, detail)
 *   detail.scope === 'group' AND detail.group set -> pauses ONLY that
 *     group. Auto-escalates to a GLOBAL halt the moment 2+ DISTINCT groups
 *     are simultaneously paused this way (a pattern, not one strict mod).
 *   anything else (the default) -> GLOBAL halt, exactly like the
 *     pre-2026-09-14 single-entry file. This is deliberate: every existing
 *     call site (checkpoint, login redirect, verify-render failure,
 *     group-post queue failure) keeps halting everything unless it
 *     explicitly opts into group scope.
 */
function setHalt(reason, detail = {}) {
  const { scope, group, ...rest } = detail;
  const entry = { reason: String(reason || 'unspecified'), halted_at: new Date().toISOString(), ...rest };
  if (group) entry.group = group;

  const state = loadState();

  if (scope !== 'group' || !group) {
    state.global = entry;
    saveState(state);
    return entry;
  }

  // Group-scoped pause.
  state.groups[group] = entry;

  const pausedGroups = Object.keys(state.groups);
  let escalated = null;
  if (pausedGroups.length >= 2) {
    escalated = {
      reason: `comment removals across ${pausedGroups.length} distinct groups`,
      halted_at: new Date().toISOString(),
      groups: pausedGroups,
    };
    state.global = escalated;
  }

  saveState(state);
  return escalated || entry;
}

/** Clears the GLOBAL halt only. Group-level pauses are untouched. */
function clearHalt() {
  const state = loadState();
  if (!state.global) return false;
  state.global = null;
  saveState(state);
  return true;
}

/** Clears ONE group's pause only. The global halt (if any) is untouched. */
function clearGroupHalt(group) {
  if (!group) return false;
  const state = loadState();
  if (!state.groups[group]) return false;
  delete state.groups[group];
  saveState(state);
  return true;
}

/** Nuclear option: clears the global halt AND every group pause. */
function clearAll() {
  try {
    if (fs.existsSync(HALT_FILE)) fs.unlinkSync(HALT_FILE);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  HALT_FILE,
  getHalt,
  isHalted,
  setHalt,
  clearHalt,
  clearGroupHalt,
  clearAll,
  getGlobalHalt,
  getGroupHalt,
  listPausedGroups,
};
