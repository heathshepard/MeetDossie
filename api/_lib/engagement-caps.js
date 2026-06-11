'use strict';

// api/_lib/engagement-caps.js
//
// Shared cap enforcement for the unified social engagement pipeline.
//
// RECALIBRATED 2026-06-10 PM by Heath:
//   - Per-platform daily caps: FB 12, IG 8, LinkedIn 6, Reddit 5, Twitter 15
//   - Total daily cap: 46 across all platforms
//   - Per-author cooldown: 7 days (unchanged)
//   - Per-thread cap: 1 (or 2 if @-mentioned)
//   - Min gap: 8 min (15 for LinkedIn/Reddit)
//   - Substance floor: 80+ chars referencing source-post specifics
//
// Constants imported from the SINGLE SOURCE OF TRUTH:
//   scripts/_lib/comment-caps.js
//
// These are NOT scanner-side caps -- the scanner happily queues hundreds of
// candidates because more raw signal is better. The caps fire at the
// Telegram-send + poster steps so:
//
//   1. Heath doesn't get a Telegram blast for candidates that would be
//      blocked anyway.
//   2. The poster never violates the spam-pattern caps even if a stale row
//      gets approved out of order.
//
// "Posted today" = status='posted' AND posted_at within UTC day window
// (intentionally UTC for cron stability).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const sharedCaps = require('../../scripts/_lib/comment-caps');

const TOTAL_DAILY_CAP = sharedCaps.TOTAL_DAILY_CAP;          // 46
const PLATFORM_DAILY_CAPS = sharedCaps.PLATFORM_DAILY_CAPS;  // per-platform map
const PER_AUTHOR_WINDOW_DAYS = sharedCaps.PER_AUTHOR_COOLDOWN_DAYS; // 7
// Kept for callers that still reference the legacy single-number export.
// Set to the smallest per-platform cap so calling code with the old single
// cap can't silently exceed Heath's tightest channel.
const PER_PLATFORM_DAILY_CAP = Math.min(...Object.values(PLATFORM_DAILY_CAPS));

async function sbFetch(urlPath, init = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, data };
}

function todayStartIsoUtc() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function nDaysAgoIso(n) {
  return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
}

// ─── Public API ──────────────────────────────────────────────────────────────

// Returns { totalPostedToday, perPlatformPostedToday: {platform: n} }.
async function loadDailyCounts() {
  const url =
    `/rest/v1/engagement_candidates` +
    `?select=platform&status=eq.posted` +
    `&posted_at=gte.${encodeURIComponent(todayStartIsoUtc())}` +
    `&limit=500`;
  const { ok, data } = await sbFetch(url);
  if (!ok || !Array.isArray(data)) {
    return { totalPostedToday: 0, perPlatformPostedToday: {} };
  }
  const perPlatformPostedToday = {};
  for (const row of data) {
    perPlatformPostedToday[row.platform] =
      (perPlatformPostedToday[row.platform] || 0) + 1;
  }
  return {
    totalPostedToday: data.length,
    perPlatformPostedToday,
  };
}

// Returns Set of author_handles that should be blocked from receiving a fresh
// draft / approval ping because we've already engaged them in the last 7 days.
async function loadAuthorBlocklist() {
  const sinceIso = nDaysAgoIso(PER_AUTHOR_WINDOW_DAYS);
  const url =
    `/rest/v1/engagement_candidates` +
    `?select=author_handle,platform,status,created_at` +
    `&status=in.(sent_for_approval,approved,posted)` +
    `&created_at=gte.${encodeURIComponent(sinceIso)}` +
    `&author_handle=not.is.null` +
    `&limit=500`;
  const { ok, data } = await sbFetch(url);
  const blocked = new Set();
  if (!ok || !Array.isArray(data)) return blocked;
  for (const row of data) {
    const key = `${row.platform}::${(row.author_handle || '').trim().toLowerCase()}`;
    if (key.endsWith('::')) continue;
    blocked.add(key);
  }
  return blocked;
}

// Mutates and returns a state object that callers can use to greedily allow
// rows one at a time while respecting all three caps.
function makeCapState({ totalPostedToday, perPlatformPostedToday }, blockedAuthors) {
  return {
    totalRemaining: Math.max(0, TOTAL_DAILY_CAP - totalPostedToday),
    perPlatformRemaining: Object.fromEntries(
      Object.entries(PLATFORM_DAILY_CAPS).map(([p, cap]) => [
        p,
        Math.max(0, cap - (perPlatformPostedToday[p] || 0)),
      ]),
    ),
    blockedAuthors,
  };
}

// Decide whether ``row`` can be sent for approval / posted. Returns
// { allow, reason }. Mutates ``state`` by decrementing remaining counts when
// allow=true, so callers can iterate a queue and stop when remaining hits 0.
function tryConsume(state, row) {
  if (state.totalRemaining <= 0) {
    return { allow: false, reason: 'total_daily_cap' };
  }
  const platform = row.platform;
  if ((state.perPlatformRemaining[platform] ?? 0) <= 0) {
    return { allow: false, reason: 'platform_daily_cap' };
  }
  const author = (row.author_handle || '').trim().toLowerCase();
  if (author) {
    const key = `${platform}::${author}`;
    if (state.blockedAuthors.has(key)) {
      return { allow: false, reason: 'author_7d_cooldown' };
    }
  }
  state.totalRemaining--;
  state.perPlatformRemaining[platform]--;
  if (author) {
    state.blockedAuthors.add(`${platform}::${author}`);
  }
  return { allow: true, reason: 'ok' };
}

module.exports = {
  TOTAL_DAILY_CAP,
  PLATFORM_DAILY_CAPS,
  PER_PLATFORM_DAILY_CAP, // legacy single-number export (tightest platform cap)
  PER_AUTHOR_WINDOW_DAYS,
  loadDailyCounts,
  loadAuthorBlocklist,
  makeCapState,
  tryConsume,
};
