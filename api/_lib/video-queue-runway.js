'use strict';

// api/_lib/video-queue-runway.js
//
// THE GAP THIS CLOSES (Atlas 2026-10-03 — "content calendar built out and
// rescheduled" task): before this, videos were registered and queued ONE AT
// A TIME, with no standing check of how many days ahead actually had
// something scheduled. Three days went dark while FOUR finished, gate-passed
// videos sat on disk unregistered — nobody was warned until Heath noticed
// the silence himself. A morning-of alert is useless; by the time the queue
// is actually empty it is too late to film (filming day is Monday — see
// memory heath-filming-day-is-monday.md).
//
// WHAT THIS DOES: runs inside the existing api/cron-post-videos.js
// invocation (no new cron, no new cron-job.org registration — CLAUDE.md
// §19's "20/20 Vercel cron cap reached" note is why this rides an
// already-firing endpoint instead of adding one). Every run it counts how
// many distinct future days (America/Chicago) have at least one
// video_library row that is scheduled and still pending publish, and keeps
// exactly one `jarvis_todos` row in sync:
//   - runway < thresholdDays  -> upsert a todo naming the exact runway and
//     the first open day, so Heath knows by when he needs to film.
//   - runway >= thresholdDays -> if that todo exists, mark it done (the
//     problem resolved itself once new videos got registered).
// jarvis_todos, not Telegram — Heath does not read Telegram (~1000 msgs/day,
// memory feedback_daily-social-ops-are-coles-job.md), but jarvis_todos IS
// the dashboard list he actually opens (memory
// feedback_use-jarvis-todos-not-heath-todo.md).
//
// WHAT "PENDING" MEANS HERE: status in ('approved', 'pending_heath_review',
// 'heath_approved') — a row still on its way to posting. 'posted'/
// 'posted_partial' already succeeded (that day is behind us, not ahead).
// A 'failed' row is NOT counted as occupying its day by this module —
// whether a failed video should keep claiming its slot (so the day after
// doesn't inherit a gap) is the "failed video still counts as owed" fix
// landing separately in api/_lib/video-reservation.js /
// api/_lib/silence-alarm.js (other agent, 2026-10-03). This module reads
// video_library's real current state at query time with zero opinion of its
// own about failed rows — once that fix lands (e.g. by re-scheduling a
// failed row forward), the next run of this check picks it up automatically
// with no change needed here.
//
// Dependency-injected `supabaseFetch` (same pattern as api/_lib/
// video-schedule.js's `restGet`) so this has zero opinion about which HTTP
// client the caller already has — cron-post-videos.js passes its own.

const { DateTime } = require('luxon');

const DEFAULT_TZ = 'America/Chicago';
const PENDING_STATUSES = ['approved', 'pending_heath_review', 'heath_approved'];
const DEFAULT_THRESHOLD_DAYS = 3;
const DEFAULT_LOOKAHEAD_DAYS = 14;
const TODO_TITLE_PREFIX = 'Content queue running low';

/**
 * @param {object} o
 * @param {(path:string, init?:object)=>Promise<{ok:boolean,status:number,data:any}>} o.supabaseFetch
 * @param {number} [o.thresholdDays]
 * @param {number} [o.lookaheadDays]
 * @param {Date} [o.now]
 * @returns {Promise<{ok:boolean, runwayDays?:number, low?:boolean, gapDate?:string|null, daysCovered?:string[], thresholdDays?:number, todoAction?:string, error?:string}>}
 */
async function checkVideoQueueRunway({
  supabaseFetch,
  thresholdDays = DEFAULT_THRESHOLD_DAYS,
  lookaheadDays = DEFAULT_LOOKAHEAD_DAYS,
  now = new Date(),
} = {}) {
  if (typeof supabaseFetch !== 'function') return { ok: false, error: 'supabaseFetch not provided' };

  const statusFilter = PENDING_STATUSES.join(',');
  const { ok, data } = await supabaseFetch(
    `/rest/v1/video_library?status=in.(${statusFilter})&scheduled_for=not.is.null&select=id,scheduled_for,status`,
  );
  if (!ok) return { ok: false, error: 'video_library query failed' };

  const rows = Array.isArray(data) ? data : [];
  const nowChicago = DateTime.fromJSDate(now).setZone(DEFAULT_TZ).startOf('day');
  const daysCovered = new Set();
  for (const row of rows) {
    if (!row.scheduled_for) continue;
    const d = DateTime.fromISO(row.scheduled_for, { zone: 'utc' });
    if (!d.isValid) continue;
    const dayChicago = d.setZone(DEFAULT_TZ).startOf('day');
    if (dayChicago >= nowChicago) daysCovered.add(dayChicago.toISODate());
  }

  let gapDate = null;
  for (let i = 0; i < lookaheadDays; i++) {
    const d = nowChicago.plus({ days: i }).toISODate();
    if (!daysCovered.has(d)) { gapDate = d; break; }
  }

  const runwayDays = daysCovered.size;
  const low = runwayDays < thresholdDays;
  const sortedDates = [...daysCovered].sort();

  // Find the one standing "low runway" todo, if any (never create duplicates).
  const { data: existingRows } = await supabaseFetch(
    `/rest/v1/jarvis_todos?title=ilike.*${encodeURIComponent(TODO_TITLE_PREFIX)}*&done=eq.false&select=id,title&order=created_at.desc&limit=1`,
  );
  const existingRow = Array.isArray(existingRows) && existingRows.length ? existingRows[0] : null;

  let todoAction = 'none';
  if (low) {
    const title = `${TODO_TITLE_PREFIX} — ${runwayDays}d scheduled, next open ${gapDate || 'now'}`;
    const detail = `${runwayDays} day(s) of video currently scheduled and not yet posted (warn threshold: ${thresholdDays}). `
      + `Covered days: ${sortedDates.join(', ') || 'none'}. First open day with nothing queued: ${gapDate || 'today'}. `
      + 'Film more and run scripts/register-local-video.js (or the normal production path) so cron-post-videos.js never finds the queue empty — filming day is Monday.';
    if (existingRow) {
      await supabaseFetch(`/rest/v1/jarvis_todos?id=eq.${existingRow.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ title, detail }),
      });
      todoAction = 'updated';
    } else {
      await supabaseFetch('/rest/v1/jarvis_todos', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ title, detail, done: false }),
      });
      todoAction = 'created';
    }
  } else if (existingRow) {
    await supabaseFetch(`/rest/v1/jarvis_todos?id=eq.${existingRow.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ done: true }),
    });
    todoAction = 'resolved';
  }

  return { ok: true, runwayDays, low, gapDate, daysCovered: sortedDates, thresholdDays, todoAction };
}

module.exports = { checkVideoQueueRunway, PENDING_STATUSES, TODO_TITLE_PREFIX, DEFAULT_THRESHOLD_DAYS };
