'use strict';

// api/_lib/video-reservation.js
//
// VIDEO-PRIORITY RESERVATION (Carter, 2026-10-01 — Heath: "Video is the
// priority. We should always be doing video moving forward.")
//
// THE PROBLEM (measured)
// -------------------------------------------------------------------------
// posting_schedule.max_per_day is a single cap per (platform, owner),
// shared between the text pipeline (api/cron-publish-approved.js) and the
// video pipeline (api/cron-post-videos.js). Each pipeline ran its OWN
// independent cap check against the SAME posting_schedule row, with no
// awareness of the other. Text runs earlier in the day (cron-publish-
// approved.js's own schedule slots fire well before the video batch scan
// gets a turn), so a day's cap was routinely fully consumed by text before
// a single video row was even considered:
//   - 2026-09-28: dossie facebook AND linkedin both sat at 2/2 from text
//     posts before the video batch scanned. Two 5-platform video rows
//     (dossie_trec_p8_disclosure-dossie-multi, dossie_trec_p12b_
//     contribution-dossie-multi) lost those platforms.
//   - 2026-09-30: dossie-trec-p21-notices-2026-09-30 (video 6, "paragraph
//     21 notices") gate-skipped Dossie Facebook at cap (2/2) and never
//     posted to that surface — corrected with a one-time manual backfill
//     on 2026-10-01 (Zernio post accepted directly, row's zernio_deliveries
//     updated to match cron-post-videos.js's own delivery-entry schema).
//
// THE FIX — RESERVE CAPACITY FOR VIDEO AT TEXT'S OWN RUN TIME
// -------------------------------------------------------------------------
// A reservation evaluated only at video-cron time is too late — by then
// text has already consumed the slot (see RULE above: text runs earlier).
// So the reservation has to be enforced at TEXT'S OWN isDueForPublish()
// call (api/cron-publish-approved.js): before letting a text post consume
// a (platform, owner) slot, count how many video_library rows are reserved
// against that same slot today, and refuse the text post unless the slot
// would still have been free after also accounting for those videos.
//
// NEW BEHAVIOUR, ONE SENTENCE: a text post may only consume a posting_
// schedule slot if doing so still leaves enough of today's max_per_day cap
// free for every video_library row that is heath_approved (or awaiting
// Heath's one-tap approval) and targets that same platform/owner today —
// so a pending video always wins the contested slot over a text post, not
// just when the video happens to get scanned first.
//
// WHY "RESERVE", NOT "SEPARATE BUDGETS": a per-pipeline split budget (e.g.
// video gets its own independent max_per_day, text gets its own) would
// require either raising the platform-safety cap (forbidden — the caps
// exist for platform rate-limit reasons, this is an allocation problem,
// not a volume one) or shrinking text's share permanently even on days
// with no video queued, wasting capacity. Reservation only withholds a
// slot from text WHEN a video genuinely needs it today, and gives that
// capacity back to text automatically once no video is pending (reserved
// count naturally falls to 0).
//
// WHICH VIDEO ROWS COUNT AS "RESERVED TODAY"
// -------------------------------------------------------------------------
// status IN ('heath_approved', 'pending_heath_review') — i.e. the row has
// already cleared the quality gate and is either about to post or one
// Telegram tap away from posting. A row still at status='approved' (not
// yet even sent to Heath for review) is NOT counted — reserving against an
// approval that might not land today would starve text indefinitely on a
// backlog that may take days to clear.
//
// AND EITHER:
//   - scheduled_for IS NULL  — "due now" under cron-post-videos.js's own
//     isDue() semantics (see video-schedule.js), so it could be picked up
//     by the very next video-cron tick regardless of what day it is. Both
//     2026-09-28 incident rows had scheduled_for=null.
//   - scheduled_for falls within TODAY's calendar day (in the schedule
//     row's own timezone) — an explicitly-booked slot for today.
//
// AND the row's `platforms` array includes the platform being checked, AND
// its target_owner matches the owner being checked (default 'dossie') —
// mirrors every other owner-scoped cap check in this codebase (Carter
// 2026-09-15/16, RUST-OWNER-WIRING).
//
// Deliberately pure / I/O-free (same pattern as api/_lib/video-delivery-
// verify.js) so it's unit-testable without mocking fetch — callers do the
// Supabase read and hand the rows in.

const RESERVE_STATUSES = new Set(['heath_approved', 'pending_heath_review']);

/**
 * @param {object} row  a video_library row (id, status, target_owner, platforms, scheduled_for)
 * @param {object} o
 * @param {string} o.platform
 * @param {string} [o.owner]          default 'dossie'
 * @param {string} o.startOfDayIso    today's start-of-day, in the schedule tz, as UTC ISO
 * @param {string} o.endOfDayIso      today's end-of-day, in the schedule tz, as UTC ISO
 * @returns {boolean}
 */
function isReservedToday(row, { platform, owner, startOfDayIso, endOfDayIso }) {
  if (!row) return false;
  if (!RESERVE_STATUSES.has(row.status)) return false;
  if ((row.target_owner || 'dossie') !== (owner || 'dossie')) return false;
  if (!Array.isArray(row.platforms) || !row.platforms.includes(platform)) return false;
  if (!row.scheduled_for) return true; // NULL = due now (video-schedule.js / cron-post-videos.js isDue())
  return row.scheduled_for >= startOfDayIso && row.scheduled_for <= endOfDayIso;
}

/**
 * @param {object[]} rows   candidate video_library rows (already filtered to
 *                          status IN (heath_approved, pending_heath_review)
 *                          and target_owner = owner by the caller's query —
 *                          this function re-checks both defensively).
 * @param {object} opts     see isReservedToday()
 * @returns {number} count of rows reserving this platform/owner slot today
 */
function countReservedForVideo(rows, opts) {
  return (Array.isArray(rows) ? rows : []).filter((r) => isReservedToday(r, opts)).length;
}

module.exports = { RESERVE_STATUSES, isReservedToday, countReservedForVideo };
