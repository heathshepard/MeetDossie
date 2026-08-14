// api/_lib/dossie-ask-priority.js
// Ordering + visibility rules for the "Dossie asks" card feed.
//
// The feed is explicitly NOT ordered by recency. It is ordered by CONSEQUENCE
// (how bad is it if this is ignored) blended with the CLOCK (how soon does it
// stop being fixable). A newly-created low-stakes ask must never outrank an
// option period expiring this afternoon.
//
// Kept in its own module so the ordering is testable in isolation and so the
// API route and any future generator agree on one definition of "most
// important".
//
// Owner: Carter, 2026-08-14 (SV-ENG-DOSSIE-ASKS)

// Consequence weight. Deliberately wide gaps: a critical ask should not be
// displaceable by clock pressure alone on a merely "normal" one.
const URGENCY_WEIGHT = {
  critical: 1000,
  high: 600,
  normal: 300,
  low: 100,
};

// Clock pressure ramps in over the final 72 hours. Beyond 72h out, a deadline
// contributes nothing — it is not yet actionable pressure. Overdue outranks
// everything within its urgency band.
const RAMP_HOURS = 72;
const MAX_RAMP_BONUS = 400;
const OVERDUE_BONUS = 500;

// How many cards render before the rest collapse behind "N more".
// Hard cap: if this surface becomes a wall of noise, agents stop reading it
// and the feature is dead. 3-5 is the deliberate ceiling.
const VISIBLE_LIMIT = 4;

function urgencyWeight(urgency) {
  return URGENCY_WEIGHT[urgency] != null ? URGENCY_WEIGHT[urgency] : URGENCY_WEIGHT.normal;
}

/**
 * Clock component of the score.
 * @param {string|null} dueAt ISO timestamp
 * @param {Date} now
 */
function clockPressure(dueAt, now) {
  if (!dueAt) return 0;
  const due = new Date(dueAt).getTime();
  if (Number.isNaN(due)) return 0;
  const hoursLeft = (due - now.getTime()) / 3600000;
  if (hoursLeft <= 0) return OVERDUE_BONUS;
  if (hoursLeft >= RAMP_HOURS) return 0;
  return MAX_RAMP_BONUS * (1 - hoursLeft / RAMP_HOURS);
}

/**
 * Blended priority score. Higher = shown first.
 */
function scoreAsk(ask, now = new Date()) {
  return urgencyWeight(ask.urgency) + clockPressure(ask.due_at, now);
}

/**
 * Is this ask currently surfaceable? Open always; snoozed only once its
 * snooze window has elapsed. Resolved/dismissed never come back.
 */
function isActive(ask, now = new Date()) {
  if (!ask) return false;
  if (ask.status === 'open') return true;
  if (ask.status === 'snoozed') {
    if (!ask.snoozed_until) return true;
    return new Date(ask.snoozed_until).getTime() <= now.getTime();
  }
  return false;
}

/**
 * Filter to active asks and sort by consequence + clock.
 * Ties break to the nearer deadline, then the older ask, so ordering is
 * stable across reloads (no cards shuffling under the agent's cursor).
 */
function sortAsks(asks, now = new Date()) {
  return (Array.isArray(asks) ? asks : [])
    .filter((a) => isActive(a, now))
    .map((a) => ({ ask: a, score: scoreAsk(a, now) }))
    .sort((x, y) => {
      if (y.score !== x.score) return y.score - x.score;
      const xd = x.ask.due_at ? new Date(x.ask.due_at).getTime() : Infinity;
      const yd = y.ask.due_at ? new Date(y.ask.due_at).getTime() : Infinity;
      if (xd !== yd) return xd - yd;
      const xc = new Date(x.ask.created_at || 0).getTime();
      const yc = new Date(y.ask.created_at || 0).getTime();
      return xc - yc;
    })
    .map((entry) => entry.ask);
}

module.exports = {
  URGENCY_WEIGHT,
  VISIBLE_LIMIT,
  RAMP_HOURS,
  scoreAsk,
  clockPressure,
  isActive,
  sortAsks,
};
