// _lib/scheduling.js
//
// Single source of truth for assigning `scheduled_for` to social_posts at the
// moment of approval. Three approval entry points (Heath swipe via
// telegram-webhook, cron-auto-approve veto window, and the retry button) all
// historically PATCHed `{ status: 'approved', approved_at: ... }` and left
// `scheduled_for` NULL. The publish cron then treats NULL as "publish now",
// bypassing the platform's daily cap and slot rules. Ridge has caught this
// twice in 24h (10 rows on 2026-06-26, 7 rows on 2026-06-27).
//
// `assignNextScheduledFor(post)` returns an ISO timestamp string for the next
// available slot for the post's platform, respecting:
//   1. posting_schedule.time_slots (per platform per day_of_week)
//   2. posting_schedule.max_per_day (per platform per day)
//   3. existing approved/publishing/posted rows for the same platform on each
//      candidate day
//   4. spacing across slots — if a slot is already taken by an
//      approved/publishing/posted row, pick the next slot or roll forward.
//
// Returns null only if no slot can be found within SEARCH_DAYS. Callers should
// treat null as a hard failure and fall back to the existing NULL behaviour
// (publish-immediately) — better to publish than silently drop.
//
// DESIGN NOTE: this helper is intentionally fetch-based (no Supabase JS SDK
// dependency) so it can be required from any cron / webhook handler without
// pulling in a heavier client.

const { DateTime } = require('luxon');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SEARCH_DAYS = 14; // look up to 2 weeks ahead before giving up

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

// Convert "HH:MM:SS" or "HH:MM" to {hour, minute}.
function parseSlot(s) {
  const parts = String(s).split(':').map((n) => parseInt(n, 10));
  return { hour: parts[0] || 0, minute: parts[1] || 0 };
}

// Load all active posting_schedule rows for a platform. Returns map by dow.
async function loadPlatformSchedules(platform) {
  const { data, ok } = await supabaseFetch(
    `/rest/v1/posting_schedule?is_active=eq.true&platform=eq.${encodeURIComponent(platform)}&select=day_of_week,time_slots,timezone,max_per_day,max_per_slot`,
  );
  if (!ok || !Array.isArray(data)) return new Map();
  const byDow = new Map();
  for (const row of data) byDow.set(row.day_of_week, row);
  return byDow;
}

// Count rows already scheduled / posted / publishing for `platform` on the
// calendar day that contains `dayStartUtc`-`dayEndUtc`. Includes rows whose
// scheduled_for OR posted_at lands inside the window (covers all states).
async function countOccupiedOnDay(platform, dayStartUtc, dayEndUtc) {
  const start = encodeURIComponent(dayStartUtc.toISOString());
  const end = encodeURIComponent(dayEndUtc.toISOString());
  // Two filters OR'd: scheduled_for in window OR posted_at in window
  // PostgREST or= syntax uses bare operators (gte.X), NOT =gte.X. The =gte
  // syntax only works at top-level where the column name precedes it. See:
  // https://postgrest.org/en/stable/api.html#logical-operators
  const filter =
    `platform=eq.${encodeURIComponent(platform)}` +
    `&status=in.(approved,publishing,posted,pending_video)` +
    `&or=(and(scheduled_for.gte.${start},scheduled_for.lte.${end}),and(posted_at.gte.${start},posted_at.lte.${end}))` +
    `&select=id,scheduled_for,posted_at,status`;
  const { data, ok } = await supabaseFetch(`/rest/v1/social_posts?${filter}`);
  return ok && Array.isArray(data) ? data : [];
}

// Find the next free slot for `platform` starting at or after `fromDt`
// (a luxon DateTime in any zone). Returns an ISO UTC string or null.
async function assignNextScheduledFor(post, opts = {}) {
  if (!post || !post.platform) return null;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;

  const fromDt = opts.fromDt instanceof DateTime ? opts.fromDt : DateTime.utc();
  const schedules = await loadPlatformSchedules(post.platform);
  if (schedules.size === 0) {
    // No schedule row for this platform — fall back to next-hour-top so the
    // publish cron doesn't fire instantly but doesn't stall forever either.
    return fromDt.plus({ hours: 1 }).startOf('hour').toUTC().toISO();
  }

  // Day-by-day search across SEARCH_DAYS in the schedule's timezone (use first
  // schedule row's tz as canonical; all rows for a platform should share one).
  const firstSchedule = [...schedules.values()][0];
  const tz = firstSchedule.timezone || 'America/Chicago';

  for (let dayOffset = 0; dayOffset < SEARCH_DAYS; dayOffset++) {
    const dayStartLocal = fromDt.setZone(tz).plus({ days: dayOffset }).startOf('day');
    const dow = dayStartLocal.weekday % 7; // luxon: Mon=1..Sun=7 → JS: Sun=0..Sat=6
    const sched = schedules.get(dow);
    if (!sched) continue; // platform doesn't post this day of week

    const dayStartUtc = dayStartLocal.toUTC().toJSDate();
    const dayEndUtc = dayStartLocal.endOf('day').toUTC().toJSDate();

    const occupied = await countOccupiedOnDay(post.platform, dayStartUtc, dayEndUtc);
    const cap = sched.max_per_day || 999;
    if (occupied.length >= cap) continue; // day is full

    // Build candidate slot list for this day, sorted ascending.
    const slots = (sched.time_slots || [])
      .map(parseSlot)
      .sort((a, b) => (a.hour - b.hour) || (a.minute - b.minute));
    if (slots.length === 0) continue;

    // Times already used on this day (snap to slot by matching hour:minute).
    const usedTimes = new Set();
    for (const row of occupied) {
      const ts = row.scheduled_for || row.posted_at;
      if (!ts) continue;
      const local = DateTime.fromISO(ts, { zone: 'utc' }).setZone(tz);
      usedTimes.add(`${local.hour}:${local.minute}`);
    }

    // Pick first slot not used today AND not in the past (when dayOffset===0).
    const nowLocal = fromDt.setZone(tz);
    for (const slot of slots) {
      const slotDt = dayStartLocal.set({ hour: slot.hour, minute: slot.minute, second: 0, millisecond: 0 });
      if (dayOffset === 0 && slotDt <= nowLocal) continue; // slot already past today
      const key = `${slot.hour}:${slot.minute}`;
      if (usedTimes.has(key)) continue;
      return slotDt.toUTC().toISO();
    }

    // No free named slot — if day has slots but cap not hit, fall back to
    // staggered hour after the last used time (so we don't drop the post on
    // days where time_slots is shorter than max_per_day, e.g. FB has 1 slot
    // but cap=2).
    if (occupied.length < cap) {
      const baseSlot = slots[slots.length - 1];
      const lastBase = dayStartLocal.set({ hour: baseSlot.hour, minute: baseSlot.minute, second: 0, millisecond: 0 });
      // Pick "base + (occupied+1) hours" — same-day staggering.
      const candidate = lastBase.plus({ hours: occupied.length + 1 });
      if (dayOffset > 0 || candidate > nowLocal) {
        return candidate.toUTC().toISO();
      }
    }
  }

  return null; // exhausted search window
}

// Convenience: patch the row's scheduled_for directly. Returns {ok, scheduled_for}.
async function assignAndPatch(postId, post, opts = {}) {
  const iso = await assignNextScheduledFor(post, opts);
  if (!iso) return { ok: false, scheduled_for: null, reason: 'no slot found' };
  const { ok, status } = await supabaseFetch(
    `/rest/v1/social_posts?id=eq.${encodeURIComponent(postId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ scheduled_for: iso }),
    },
  );
  return { ok, status, scheduled_for: iso };
}

module.exports = {
  assignNextScheduledFor,
  assignAndPatch,
  loadPlatformSchedules, // exported for tests
};
