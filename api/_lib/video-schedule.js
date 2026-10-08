'use strict';

// api/_lib/video-schedule.js
//
// Auto-schedule a freshly-registered video (Atlas, 2026-09-25 —
// "we need videos to also be scheduled when they are made").
//
// Every registration path (api/register-video.js, scripts/video-engine/
// queue-variant.js, scripts/register-local-video.js) ends the same way: an
// upsert into video_library. Before 2026-09-25 that row shipped with no
// opinion about WHEN it should post — it just sat oldest-first behind
// whatever else was heath_approved. pickScheduledFor() gives it a real
// scheduled_for by walking the same posting_schedule table
// api/cron-post-videos.js already uses to gate the actual publish, so a new
// video lands in the next slot that (a) is in the future and (b) isn't
// already claimed by another pending video.
//
// This is a PLANNING gate, not the publish gate. cron-post-videos.js still
// does its own real per-platform posting_schedule resolution at post time —
// this only decides when a row becomes ELIGIBLE to be picked up (see that
// file's Step 2 query). A NULL scheduled_for (this function's return when it
// can't find a slot, or when the caller skips calling it) means "no
// preference" and behaves exactly like every pre-2026-09-25 row.
//
// scripts/queue-finished-videos.py carries an equivalent implementation in
// Python (assign_next_slot()) — the two are duplicated by necessity (one
// runtime can't import the other) but documented as mirrors of the same
// algorithm; changing the slot logic here without changing it there is a bug.

const { DateTime } = require('luxon');

const DEFAULT_TZ = 'America/Chicago';
const LOOKAHEAD_DAYS = 14;

// Statuses that mean "this row is done deciding when to post" — a video in
// one of these no longer occupies a slot for collision purposes.
const TERMINAL_STATUSES = new Set(['posted', 'rejected', 'retracted', 'quality_hold']);

/**
 * @param {object} o
 * @param {string[]} o.platforms   the video's platforms array (non-empty)
 * @param {string} [o.owner]       'dossie' | 'heath-realtor' | 'rust' — default 'dossie'
 * @param {string} [o.excludeId]   video_library.id to exclude from the occupancy scan (re-scheduling)
 * @param {(query:string)=>Promise<{ok:boolean,data:any}>} o.restGet
 *   caller-supplied GET against Supabase PostgREST — `query` is the path
 *   AFTER `/rest/v1/`, e.g. `posting_schedule?select=...`. Kept generic so
 *   this module has zero opinion about which HTTP client or Supabase helper
 *   the caller already has (register-video.js's plain fetch, queue-variant.js's
 *   sb(), etc).
 * @param {Date} [o.now]
 * @returns {Promise<string|null>} ISO timestamp, or null if no slot found in
 *   the lookahead window (caller should leave scheduled_for NULL, not throw —
 *   an unscheduled video is the pre-existing, working behavior).
 */
async function pickScheduledFor({ platforms, owner = 'dossie', excludeId = null, restGet, now = new Date() }) {
  if (!Array.isArray(platforms) || platforms.length === 0 || typeof restGet !== 'function') return null;
  const anchor = platforms[0];

  let scheduleRows = [];
  try {
    const { ok, data } = await restGet(
      `posting_schedule?platform=eq.${encodeURIComponent(anchor)}&select=platform,day_of_week,time_slots,timezone,is_active,owner`,
    );
    if (ok && Array.isArray(data)) scheduleRows = data;
  } catch { /* fail soft — return null below, video stays unscheduled */ }
  if (!scheduleRows.length) return null;

  // Occupied slots: any non-terminal video_library row that already carries
  // a future scheduled_for and includes the anchor platform. Compared to the
  // minute (schedule slots are HH:MM) so two rows never land on the exact
  // same anchor-platform slot.
  const occupied = new Set();
  try {
    const { ok, data } = await restGet(
      `video_library?scheduled_for=not.is.null&select=id,scheduled_for,platforms,status`,
    );
    if (ok && Array.isArray(data)) {
      for (const row of data) {
        if (row.id === excludeId) continue;
        if (TERMINAL_STATUSES.has(row.status)) continue;
        if (!Array.isArray(row.platforms) || !row.platforms.includes(anchor)) continue;
        if (!row.scheduled_for) continue;
        const t = DateTime.fromISO(row.scheduled_for, { zone: 'utc' });
        if (t.isValid) occupied.add(t.toFormat("yyyy-LL-dd'T'HH:mm"));
      }
    }
  } catch { /* an occupancy-read failure should not block scheduling; worst case is a double-booked slot */ }

  for (let dayOffset = 0; dayOffset < LOOKAHEAD_DAYS; dayOffset++) {
    const candidateDay = DateTime.fromJSDate(now).plus({ days: dayOffset });
    const dow = candidateDay.weekday % 7; // luxon Mon=1..Sun=7 -> Sun=0..Sat=6, matches cron-post-videos.js

    const row = scheduleRows.find((r) => r.day_of_week === dow && (r.owner === owner || r.owner == null) && r.is_active !== false)
      || scheduleRows.find((r) => r.day_of_week === dow && r.owner == null && r.is_active !== false);
    if (!row) continue;

    const tz = row.timezone || DEFAULT_TZ;
    const dayInTz = candidateDay.setZone(tz);
    const slots = Array.isArray(row.time_slots) ? [...row.time_slots].sort() : [];

    for (const slot of slots) {
      const [h, m] = String(slot).split(':').map(Number);
      const candidate = dayInTz.set({ hour: h || 0, minute: m || 0, second: 0, millisecond: 0 });
      const candidateUtc = candidate.toUTC();
      if (candidate <= DateTime.fromJSDate(now).setZone(tz)) continue; // must be strictly future
      const key = candidateUtc.toFormat("yyyy-LL-dd'T'HH:mm");
      if (occupied.has(key)) continue;
      return candidateUtc.toISO();
    }
  }
  return null; // no free slot in the lookahead window — leave scheduled_for NULL
}

module.exports = { pickScheduledFor, TERMINAL_STATUSES, LOOKAHEAD_DAYS };
