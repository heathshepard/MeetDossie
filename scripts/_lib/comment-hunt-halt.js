'use strict';

// scripts/_lib/comment-hunt-halt.js
//
// CIRCUIT BREAKER for the daily comment-opportunity pipeline. The entire
// distribution strategy runs through ONE Facebook profile that was
// shadowbanned in June from automated bursts — losing it ends everything, so
// the pipeline stops COMPLETELY on the first warning sign and stays stopped
// until a human clears it.
//
// Halt triggers (written by fb-comment-hunt-daily.js / fb-comment-opp-poster.js):
//   - a previously posted comment is no longer present in its thread (removed
//     by a mod or by Facebook)
//   - Facebook redirects to login / checkpoint (temp block / logged out)
//   - a submitted comment fails to render back on re-read (verify failure)
//
// While halted: the scanner scans nothing, the poster posts nothing. Approved
// rows keep their status and post after the halt is cleared.
//
// Clear it ONLY after eyeballing the profile on Facebook:
//   node scripts/fb-comment-opp-poster.js --clear-halt
// (or delete scripts/.comment-hunt-halt.json by hand).
//
// Owner: Carter, 2026-09-08

const fs = require('fs');
const path = require('path');

const HALT_FILE = path.join(__dirname, '..', '.comment-hunt-halt.json');

function getHalt() {
  try {
    if (fs.existsSync(HALT_FILE)) {
      return JSON.parse(fs.readFileSync(HALT_FILE, 'utf8'));
    }
  } catch (e) {
    // Corrupt halt file = still halted. Fail SAFE, never fail open.
    return { reason: `halt file unreadable: ${e.message}`, halted_at: null };
  }
  return null;
}

function isHalted() {
  return getHalt() !== null;
}

function setHalt(reason, detail = {}) {
  const entry = {
    reason: String(reason || 'unspecified'),
    halted_at: new Date().toISOString(),
    ...detail,
  };
  fs.writeFileSync(HALT_FILE, JSON.stringify(entry, null, 2), 'utf8');
  return entry;
}

function clearHalt() {
  try {
    if (fs.existsSync(HALT_FILE)) fs.unlinkSync(HALT_FILE);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { HALT_FILE, getHalt, isHalted, setHalt, clearHalt };
