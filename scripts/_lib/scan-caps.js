'use strict';

// scripts/_lib/scan-caps.js
//
// Anti-ban pacing for READ-ONLY group scanning/discovery, sibling to
// comment-caps.js (which governs POSTING/commenting caps). Heath's ask
// 2026-08-17: "there are more things to interact with than we probably
// should, so we dont get banned" -- more surface, but paced like a real
// account, not a script hitting every group back-to-back.
//
// Why a separate file from comment-caps.js: that module's caps + state live
// in the `comment_caps_state` Supabase table and are scoped to *posting*
// actions. Scanning (fb-engagement-scraper.js, fb-group-discovery.js) never
// posts/comments/joins, but visiting dozens of group pages back-to-back at
// machine speed is still a bot signature FB's abuse systems watch for
// (sequential navigations, near-zero jitter, no idle time). This gives
// scanning its own daily ceiling and its own local state file so it doesn't
// need a DB migration to ship.
//
// State lives in scripts/.scan-caps-state.json (one row per UTC day).

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', '.scan-caps-state.json');

// Reasoning: a genuinely active solo agent might browse/skim 15-25 FB groups
// in a day if they're hunting for something specific; that's the plausible
// human ceiling this should look like from FB's side. Read-only scanning
// (fb-engagement-scraper.js) and one-time discovery/verification visits
// (fb-group-discovery.js) share this ceiling since both are "load a group
// page and look at it" from FB's perspective.
const DAILY_GROUP_SCAN_CAP = 25;

// Group-page-to-group-page dwell time (ms). Randomized so consecutive visits
// don't land on a mechanical interval -- real browsing is bursty and uneven.
const SCAN_DWELL_MS = { min: 2500, max: 6000 };
// Within-page scroll-step pacing (ms) -- avoids a metronome-perfect scroll
// cadence, which is itself a detectable pattern.
const SCROLL_STEP_MS = { min: 1400, max: 3200 };

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) { /* corrupt/missing -> start fresh */ }
  return {};
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
  } catch (e) {
    console.warn('[scan-caps] could not persist state:', e.message);
  }
}

/** How many group pages have already been scanned/visited today. */
function todayCount() {
  const state = loadState();
  return state[todayKey()] || 0;
}

/**
 * Can we scan `n` more group pages today without breaching the daily cap?
 * Returns { allowed, remaining, cap }.
 */
function canScan(n = 1) {
  const used = todayCount();
  const remaining = Math.max(0, DAILY_GROUP_SCAN_CAP - used);
  return { allowed: n <= remaining, remaining, cap: DAILY_GROUP_SCAN_CAP, used };
}

/** Record that `n` more group pages were scanned/visited today. */
function recordScan(n = 1) {
  const state = loadState();
  const key = todayKey();
  state[key] = (state[key] || 0) + n;
  // Prune old days so the file doesn't grow forever.
  for (const k of Object.keys(state)) {
    if (k !== key && Date.parse(k) < Date.now() - 14 * 86400000) delete state[k];
  }
  saveState(state);
  return state[key];
}

function randDelay(range) {
  const { min, max } = range;
  return new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
}

module.exports = {
  DAILY_GROUP_SCAN_CAP,
  SCAN_DWELL_MS,
  SCROLL_STEP_MS,
  todayKey,
  todayCount,
  canScan,
  recordScan,
  randDelay,
};
