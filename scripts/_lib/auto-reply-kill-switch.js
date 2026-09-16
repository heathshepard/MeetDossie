'use strict';

// scripts/_lib/auto-reply-kill-switch.js
//
// GLOBAL kill switch for the auto-reply-with-veto feature ONLY (see
// supabase/migrations/20260916_auto_reply_veto.sql). Deliberately a
// SEPARATE file from scripts/_lib/comment-hunt-halt.js — that circuit
// breaker halts the whole comment-hunt/group-post pipeline on
// account-level Facebook signals (checkpoint, login redirect, removed
// comment). This switch controls exactly one thing: whether a low-risk
// reply may EVER take the veto-timeout auto-post path. Reusing the halt
// file would mean an unrelated FB-account issue could silently flip
// auto-reply back on (or vice versa) as a side effect — kept separate on
// purpose.
//
// Defaults OFF. Ship-time requirement: this feature must be OFF in
// production until Heath (and Quinn) explicitly turn it on.
//
// Read by:
//   - api/cron-tc-reply-approval.js       (gates entry into pending_veto)
//   - api/cron-auto-reply-veto-check.js   (gates the actual auto-approve)
//   - scripts/fb-group-commenter.js       (defense-in-depth: refuses to
//                                          post an auto_approved row if the
//                                          switch is off, even if it was
//                                          flipped off AFTER auto-approval)
//
// Flip with:
//   node scripts/toggle-auto-reply.js on
//   node scripts/toggle-auto-reply.js off
//   node scripts/toggle-auto-reply.js status
//
// Owner: Carter, 2026-09-16

const fs = require('fs');
const path = require('path');

// AUTO_REPLY_SWITCH_FILE lets regression tests point this at a scratch file
// instead of the real state file. Unset in production.
const SWITCH_FILE = process.env.AUTO_REPLY_SWITCH_FILE
  || path.join(__dirname, '..', '.auto-reply-kill-switch.json');

function loadState() {
  try {
    if (!fs.existsSync(SWITCH_FILE)) return { enabled: false, updated_at: null, reason: null };
    const raw = JSON.parse(fs.readFileSync(SWITCH_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && typeof raw.enabled === 'boolean') return raw;
    return { enabled: false, updated_at: null, reason: 'malformed state file' };
  } catch (e) {
    // Corrupt file = fail SAFE = disabled, never fail open.
    return { enabled: false, updated_at: null, reason: `state file unreadable: ${e.message}` };
  }
}

function saveState(state) {
  fs.writeFileSync(SWITCH_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/** @returns {boolean} */
function isAutoReplyEnabled() {
  return loadState().enabled === true;
}

/** @returns {{enabled: boolean, updated_at: string|null, reason: string|null}} */
function getState() {
  return loadState();
}

function enableAutoReply(reason = 'manual enable') {
  const state = { enabled: true, updated_at: new Date().toISOString(), reason: String(reason) };
  saveState(state);
  return state;
}

function disableAutoReply(reason = 'manual disable') {
  const state = { enabled: false, updated_at: new Date().toISOString(), reason: String(reason) };
  saveState(state);
  return state;
}

module.exports = {
  SWITCH_FILE,
  isAutoReplyEnabled,
  getState,
  enableAutoReply,
  disableAutoReply,
};
