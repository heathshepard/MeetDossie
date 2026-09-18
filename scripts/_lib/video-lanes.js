'use strict';

// scripts/_lib/video-lanes.js
//
// ONE PLACE that answers "which platforms does this owner's video actually go
// to today, and in which shape."
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS — the mixed-platforms landmine
// ---------------------------------------------------------------------------
// Two files disagreed about orientation and the disagreement failed CLOSED.
//
//   scripts/queue-finished-videos.py wrote ONE row per video with the owner's
//   whole platform list on it:
//       DOSSIE_SELFIE_PLATFORMS  = [facebook, instagram, tiktok, youtube]
//       REALTOR_SELFIE_PLATFORMS = [facebook, instagram]
//       RUST_PLATFORMS           = [instagram, twitter]
//
//   api/_lib/verify-video-quality.js's classifyOrientation() THROWS on a
//   platforms array that mixes its vertical family (tiktok/instagram) with its
//   horizontal family (facebook/twitter/linkedin/youtube), because this
//   pipeline ships one shape per video_library row.
//
// Every one of those three lane constants is a mixed array. queue-finished-
// videos.py passes the row's real platforms to the gate (line 735), so the gate
// throws, `orientation_determined` fails, and the whole gate fails closed →
// status='quality_hold'. Every hand-dropped clip for every owner. The reason
// this has not been screaming is that the two live generators (D1, R1) write
// their video_library rows themselves and never went through that scanner.
//
// It is also the wrong ANSWER even when it does not throw: a single 1080x1920
// asset tagged facebook+instagram+tiktok+youtube is one file posted to two
// surfaces that want 9:16 and two that want 16:9.
//
// The fix is not to pick one shape and drop platforms. It is to render BOTH
// shapes from the same day's material and split the lane into two rows —
// which is what splitLanes() below returns and what
// scripts/daily-video-supply.js now does.
//
// ---------------------------------------------------------------------------
// YOUTUBE IS VERTICAL HERE
// ---------------------------------------------------------------------------
// verify-video-quality.js originally listed youtube under HORIZONTAL_PLATFORMS.
// queue-finished-videos.py's own comment says the opposite and is right about
// what we actually publish: "YouTube Shorts wants the same 1080x1920 vertical
// asset tiktok/instagram already get from build-shortform-video.py... Desktop
// (landscape) screen recordings stay off youtube - Shorts is vertical-only."
// Shorts is the destination, so youtube sits in the vertical family, and the
// gate was corrected to match (not the other way round).
//
// ---------------------------------------------------------------------------
// ACCOUNTS ARE FACTS, NOT CONSTANTS
// ---------------------------------------------------------------------------
// A lane may only contain a platform that owner genuinely has a connected,
// active Zernio account for. That lives in the `zernio_accounts` table, which
// api/cron-post-videos.js's resolveZernioAccountId() already treats as the
// source of truth (and which never falls back to a Dossie account for a
// non-dossie owner). loadOwnerLanes() reads it live. The hardcoded map below is
// a documented fallback for offline/plan runs ONLY, mirroring the rows present
// on 2026-09-18, and it is reported as a fallback rather than passed off as the
// live answer.

const VERTICAL_PLATFORMS = ['instagram', 'tiktok', 'youtube'];
const HORIZONTAL_PLATFORMS = ['facebook', 'twitter', 'linkedin'];

// Mirrors `select owner, platform from zernio_accounts where is_active` as of
// 2026-09-18. Used only when the DB cannot be read; every caller that uses it
// gets `source: 'fallback'` back and should say so rather than claim live data.
const FALLBACK_ACCOUNTS = {
  dossie: ['facebook', 'instagram', 'linkedin', 'tiktok', 'twitter', 'youtube'],
  'heath-realtor': ['facebook', 'instagram', 'youtube'],
  rust: ['instagram', 'twitter'],
};

const OWNERS = ['dossie', 'heath-realtor', 'rust'];

/** 'vertical' | 'horizontal' | null for an unrecognised platform. */
function familyOf(platform) {
  if (VERTICAL_PLATFORMS.includes(platform)) return 'vertical';
  if (HORIZONTAL_PLATFORMS.includes(platform)) return 'horizontal';
  return null;
}

/**
 * Split a flat platform list into the two orientation lanes.
 * Unrecognised platforms are returned separately rather than silently dropped —
 * a platform nobody classified is a configuration bug, not an empty set.
 */
function splitLanes(platforms) {
  const vertical = [];
  const horizontal = [];
  const unknown = [];
  for (const p of platforms || []) {
    const f = familyOf(p);
    if (f === 'vertical') vertical.push(p);
    else if (f === 'horizontal') horizontal.push(p);
    else unknown.push(p);
  }
  return { vertical, horizontal, unknown };
}

async function sbSelect(pathAndQuery) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    const res = await fetch(`${url}${pathAndQuery}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Live per-owner lanes, read from zernio_accounts.
 *
 * Returns {
 *   source: 'live' | 'fallback',
 *   owners: { [owner]: { accounts: [...], vertical: [...], horizontal: [...] } },
 * }
 *
 * A platform with no active account for that owner is ABSENT from both lanes.
 * That is the honest answer — cron-post-videos.js would fail account
 * resolution on it anyway, and listing it would make a dead platform look fed.
 */
async function loadOwnerLanes() {
  const rows = await sbSelect('/rest/v1/zernio_accounts?is_active=eq.true&select=owner,platform');
  const live = Array.isArray(rows) && rows.length > 0;
  const byOwner = {};
  if (live) {
    for (const r of rows) {
      if (!r || !r.owner || !r.platform) continue;
      (byOwner[r.owner] = byOwner[r.owner] || []).push(r.platform);
    }
  }
  const owners = {};
  for (const owner of OWNERS) {
    const accounts = (live ? byOwner[owner] : FALLBACK_ACCOUNTS[owner]) || [];
    const lanes = splitLanes(accounts);
    owners[owner] = {
      accounts: accounts.slice().sort(),
      vertical: lanes.vertical.sort(),
      horizontal: lanes.horizontal.sort(),
      unknown: lanes.unknown.sort(),
    };
  }
  return { source: live ? 'live' : 'fallback', owners };
}

/**
 * Which of an owner's lanes are actually SCHEDULED to accept a post today.
 *
 * posting_schedule is the live gate api/cron-post-videos.js enforces: a
 * platform with no row for today, or an is_active=false row, is skipped at post
 * time no matter what the video_library row says. Today, Dossie's shared
 * `twitter` rows are is_active=false for all 7 days while the owner='rust'
 * twitter override is active — so "Dossie posts to X daily" would be a false
 * claim and this is what proves it either way.
 *
 * Returns { [owner]: { [platform]: {scheduled: bool, reason: string} } }, or
 * null if the table could not be read (never a guess).
 */
async function loadScheduleToday(dayOfWeek) {
  const dow = Number.isInteger(dayOfWeek) ? dayOfWeek : new Date().getDay();
  const rows = await sbSelect(
    `/rest/v1/posting_schedule?day_of_week=eq.${dow}&select=owner,platform,is_active,max_per_day,time_slots`,
  );
  if (!Array.isArray(rows)) return null;
  // Owner-specific row wins over the shared (owner IS NULL) row, matching
  // gatePlatform()'s `entry.owners.get(owner) || entry.shared`.
  const shared = new Map();
  const owned = new Map();
  for (const r of rows) {
    if (r.owner) owned.set(`${r.owner}::${r.platform}`, r);
    else shared.set(r.platform, r);
  }
  const out = {};
  for (const owner of OWNERS) {
    out[owner] = {};
    for (const p of [...VERTICAL_PLATFORMS, ...HORIZONTAL_PLATFORMS]) {
      const row = owned.get(`${owner}::${p}`) || shared.get(p) || null;
      out[owner][p] = row
        ? {
          scheduled: !!row.is_active,
          maxPerDay: row.max_per_day,
          slots: row.time_slots,
          reason: row.is_active
            ? `${row.owner ? `owner override` : 'shared row'}: active, max ${row.max_per_day}/day at ${(row.time_slots || []).join(', ')}`
            : `${row.owner ? `owner override` : 'shared row'}: is_active=false — posting_schedule has this platform switched OFF`,
        }
        : { scheduled: false, maxPerDay: null, slots: null, reason: 'no posting_schedule row for this day of week' };
    }
  }
  return out;
}

module.exports = {
  VERTICAL_PLATFORMS,
  HORIZONTAL_PLATFORMS,
  FALLBACK_ACCOUNTS,
  OWNERS,
  familyOf,
  splitLanes,
  loadOwnerLanes,
  loadScheduleToday,
};
