'use strict';

// api/_lib/outcome-escalation.js
//
// Escalation with teeth. Heath should hear from this roughly never -- and when
// he does, it should be impossible to ignore and take under five minutes.
//
// THE INVERSION THIS FIXES
// The old pattern (alert_state + a flat 20h cooldown per condition key) had two
// failure modes, both of which fired in the same week:
//   - A useless summary went out 96 times a day while the REAL alert next to it
//     ("LinkedIn login required") was suppressed by its own cooldown.
//   - connectMLS hit 34 consecutive failed probes over 19 days and got quieter
//     the whole time, because a cooldown treats "still broken" as "already told
//     you".
//
// Three structural rules, all enforced here:
//
//   RULE A -- A NEW PROBLEM CLASS IS NEVER SUPPRESSED.
//     Incidents are keyed (expectation_key, cause). A different cause cannot
//     join an existing incident; it opens a new one at level 0 and fires on the
//     spot. No cooldown can sit in front of something we have not said yet.
//
//   RULE B -- UNRESOLVED GETS LOUDER, NEVER QUIETER.
//     The resend interval SHRINKS as escalation level rises:
//       L0 24h -> L1 12h -> L2 6h -> L3 3h (floor).
//     That is the opposite of exponential backoff, on purpose. Backoff is right
//     for a flaky dependency and catastrophic for a thing only Heath can fix.
//
//   RULE C -- EVERY MESSAGE CARRIES COST AND CURE.
//     How long it has been broken, what it has cost in units he cares about,
//     and the exact fix. "FB groups down 8 days, 3 posts unsent, ~2 min to fix"
//     -- not "group_posting_silent".
//
// Owner: Atlas, 2026-09-25

const { sb } = require('./outcome-expectations.js');

// Level -> hours before the SAME incident may speak again. Monotonically
// decreasing by design (RULE B).
const RESEND_HOURS = [24, 12, 6, 3];

// How long an incident must stay open before it climbs a level.
const LEVEL_UP_AFTER_HOURS = [24, 72, 168]; // -> L1 at 1d, L2 at 3d, L3 at 7d

/**
 * How long has this actually been broken?
 * Prefers the true outage age from the system of record and falls back to how
 * long the incident has been open. Always the LARGER of the two — the monitor
 * noticing late must never shrink the reported outage.
 */
function incidentAgeHours(incident, outageHours = null) {
  const sinceOpened = (Date.now() - new Date(incident.opened_at).getTime()) / 3600000;
  const fromRecord = (typeof outageHours === 'number' && Number.isFinite(outageHours))
    ? outageHours
    : (incident.detail && typeof incident.detail.outage_hours === 'number' ? incident.detail.outage_hours : null);
  return fromRecord === null ? sinceOpened : Math.max(sinceOpened, fromRecord);
}

function levelForAge(ageHours) {
  let lvl = 0;
  for (const t of LEVEL_UP_AFTER_HOURS) { if (ageHours >= t) lvl += 1; }
  return Math.min(lvl, RESEND_HOURS.length - 1);
}

function resendIntervalHours(level) {
  return RESEND_HOURS[Math.min(Math.max(level, 0), RESEND_HOURS.length - 1)];
}

// ─── Incident lifecycle ──────────────────────────────────────────────────────

async function findOpenIncident(expectationKey, cause) {
  const { ok, data } = await sb(
    `outcome_incidents?expectation_key=eq.${encodeURIComponent(expectationKey)}` +
    `&cause=eq.${encodeURIComponent(cause)}&resolved_at=is.null&select=*&limit=1`
  );
  return ok && Array.isArray(data) && data[0] ? data[0] : null;
}

async function openIncident(exp, cause, detail, backlog, outageHours = null) {
  const merged = { ...(detail || {}) };
  if (typeof outageHours === 'number') merged.outage_hours = outageHours;
  // A brand-new incident for an outage the records say is already days old
  // starts at the level that age deserves -- it does not restart at zero just
  // because this is the first time anyone looked.
  const level = outageHours === null ? 0 : levelForAge(outageHours);
  const { ok, data } = await sb('outcome_incidents', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      expectation_key: exp.key,
      cause: cause.cause,
      consecutive_failures: 1,
      escalation_level: level,
      backlog_count: backlog ?? null,
      detail: merged,
    }]),
  });
  return ok && Array.isArray(data) && data[0] ? data[0] : null;
}

async function touchIncident(incident, detail, backlog, outageHours = null) {
  const ageHours = incidentAgeHours(incident, outageHours);
  const level = Math.max(incident.escalation_level, levelForAge(ageHours));
  const { ok, data } = await sb(`outcome_incidents?id=eq.${incident.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      last_seen_at: new Date().toISOString(),
      consecutive_failures: (incident.consecutive_failures || 0) + 1,
      escalation_level: level,
      backlog_count: backlog ?? incident.backlog_count,
      detail: detail || incident.detail,
    }),
  });
  return ok && Array.isArray(data) && data[0] ? data[0] : { ...incident, escalation_level: level };
}

/**
 * Close every open incident for an expectation that is now met.
 * Returns the closed rows so the caller can send one recovery line -- silence
 * after a loud alert reads as "still broken", which is its own failure mode.
 */
async function resolveIncidents(expectationKey, resolution) {
  const { ok, data } = await sb(
    `outcome_incidents?expectation_key=eq.${encodeURIComponent(expectationKey)}&resolved_at=is.null&select=*`
  );
  if (!ok || !Array.isArray(data) || !data.length) return [];
  await sb(`outcome_incidents?expectation_key=eq.${encodeURIComponent(expectationKey)}&resolved_at=is.null`, {
    method: 'PATCH',
    body: JSON.stringify({ resolved_at: new Date().toISOString(), resolution }),
  });
  return data;
}

// ─── Delivery accounting ─────────────────────────────────────────────────────
//
// BUGFIX 2026-09-25 (Atlas). The function that lived here was markEscalated(),
// and outcome-monitor.js called it the moment the alert TEXT was formatted --
// before the cron had tried to send anything, and with nothing anywhere that
// checked telegramGate.wasSuppressed() on the gate's fake 200. So an incident
// could be stamped last_escalated_at + escalation_count++ for a message Heath
// never received, and the shrinking-resend ladder would then dutifully hold its
// tongue for 24h because it "already told him".
//
// That is precisely the failure this monitor exists to catch -- recording an
// action as done without verifying it happened. It is the 2026-08-17 shape
// exactly: cron-video-approval marked five videos pending_approval off a
// suppressed send and they sat invisible for three weeks.
//
// So the ladder now advances on EVIDENCE, and on nothing else:
//   sent        -> last_escalated_at + escalation_count. The only state that
//                  counts as having spoken to Heath, and the only one that
//                  starts a resend interval.
//   suppressed  -> the gate ate it. suppressed_escalations++ and NOTHING else.
//                  last_escalated_at is untouched, so shouldEscalate() returns
//                  "escalate" again on the very next run and the incident
//                  speaks the instant the gate opens.
//   failed      -> the API refused or the fetch threw. failed_escalations++,
//                  same "still due" treatment as suppressed.
// last_delivery_state / _at / _detail keep the three distinguishable on the row
// afterwards, which is the difference between "quiet because healthy" and
// "quiet because muted".

const DELIVERY_STATES = ['sent', 'suppressed', 'failed'];

/**
 * The patch a given delivery outcome earns. PURE -- no I/O -- so the rule
 * "a suppressed send must not advance the ladder" is directly testable
 * (scripts/regression-outcome-monitor.js).
 * @param {object} incident
 * @param {{state:string, detail?:string}} delivery
 */
function escalationPatch(incident, delivery) {
  // Unknown/missing state is treated as FAILED, never as sent. Fail closed:
  // the cost of a duplicate alert is noise, the cost of a swallowed one is the
  // three-week outage this whole system was built after.
  const state = delivery && DELIVERY_STATES.includes(delivery.state) ? delivery.state : 'failed';
  const now = new Date().toISOString();
  const patch = {
    last_delivery_state: state,
    last_delivery_at: now,
    last_delivery_detail: delivery && delivery.detail ? String(delivery.detail).slice(0, 300) : null,
  };
  if (state === 'sent') {
    patch.last_escalated_at = now;
    patch.escalation_count = (incident.escalation_count || 0) + 1;
  } else if (state === 'suppressed') {
    patch.suppressed_escalations = (incident.suppressed_escalations || 0) + 1;
  } else {
    patch.failed_escalations = (incident.failed_escalations || 0) + 1;
  }
  return patch;
}

/**
 * Write that outcome to the incident row. Returns whether the WRITE landed --
 * a monitor that cannot record its own state must say so rather than assume.
 */
async function recordEscalationOutcome(incident, delivery) {
  if (!incident || !incident.id) return { ok: false, state: null, reason: 'no incident row' };
  const patch = escalationPatch(incident, delivery);
  const r = await sb(`outcome_incidents?id=eq.${incident.id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return { ok: !!r.ok, status: r.status, state: patch.last_delivery_state,
           error: r.ok ? null : String(JSON.stringify(r.data)).slice(0, 200) };
}

// ─── The decision ────────────────────────────────────────────────────────────

/**
 * shouldEscalate(exp, incident, { isNew })
 *
 * RULE A: a brand-new incident (new expectation OR new cause) always speaks.
 * RULE B: an existing one speaks again once its level's shrinking interval has
 *         elapsed -- and the interval only ever gets shorter.
 * grace_hours lets a short, expected gap stay quiet, but it applies to the
 * incident's AGE, never to whether we are allowed to mention it at all.
 *
 * Note what `!incident.last_escalated_at` buys, now that only a CONFIRMED send
 * sets it: an incident whose alert was eaten by the telegram gate still has a
 * null last_escalated_at, so it stays due on every subsequent run and speaks
 * the moment the gate opens. Suppression delays the message; it can never
 * cancel it.
 */
function shouldEscalate(exp, incident, { isNew = false, outageHours = null } = {}) {
  // Age is the TRUE outage age where the system of record can supply one
  // (last_produced_at), not just how long the monitor has known. Otherwise a
  // channel that had already been dead 8 days would sit inside its own grace
  // period on the monitor's first run -- the monitor would be the last thing
  // to notice, which defeats the entire exercise.
  const ageHours = incidentAgeHours(incident, outageHours);
  if (ageHours < Number(exp.grace_hours || 0)) {
    return { escalate: false, reason: `within grace period (${exp.grace_hours}h, actual age ${ageHours.toFixed(1)}h)` };
  }
  if (isNew || !incident.last_escalated_at) {
    return { escalate: true, reason: 'new problem class -- never suppressed' };
  }
  const sinceH = (Date.now() - new Date(incident.last_escalated_at).getTime()) / 3600000;
  const need = resendIntervalHours(incident.escalation_level);
  if (sinceH >= need) {
    return { escalate: true, reason: `unresolved ${Math.round(ageHours)}h, level ${incident.escalation_level}, resend every ${need}h` };
  }
  return { escalate: false, reason: `next resend in ${(need - sinceH).toFixed(1)}h (level ${incident.escalation_level})` };
}

// ─── Message text ────────────────────────────────────────────────────────────

function humanDuration(hours) {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)} days`;
}

const LEVEL_PREFIX = ['', 'STILL BROKEN', 'STILL BROKEN (3+ days)', 'STILL BROKEN (a week)'];

/**
 * Build the alert. Cost and cure are mandatory, not decoration -- an alert
 * Heath has to go investigate is an alert he will defer.
 */
function formatEscalation(exp, incident, cause, extra = {}) {
  const ageHours = incidentAgeHours(incident, extra.outage_hours ?? null);
  const lvl = incident.escalation_level || 0;
  const prefix = LEVEL_PREFIX[Math.min(lvl, LEVEL_PREFIX.length - 1)];

  const lines = [];
  lines.push(`${prefix ? `[${prefix}] ` : ''}${exp.label} — below floor`);

  // The cost line.
  const bits = [`down ${humanDuration(ageHours)}`];
  if (extra.actual !== undefined && extra.expected !== undefined) {
    bits.push(`${extra.actual}/${extra.expected} in the last ${exp.window_hours}h`);
  }
  if (incident.backlog_count) {
    bits.push(`${incident.backlog_count} ${exp.cost_unit || 'items'}`);
  }
  if (exp.human_fix_minutes) bits.push(`~${exp.human_fix_minutes} min to fix`);
  lines.push(bits.join(', '));

  lines.push(`Cause: ${cause.cause}${cause.confidence ? ` (${cause.confidence} confidence)` : ''}`);

  if (extra.remediation_summary) lines.push(`Tried: ${extra.remediation_summary}`);

  if (exp.human_fix) lines.push(`Fix: ${exp.human_fix}`);

  if (cause.detail && Object.keys(cause.detail).length) {
    lines.push(`Detail: ${JSON.stringify(cause.detail).slice(0, 400)}`);
  }
  return lines.join('\n');
}

function formatRecovery(exp, incidents) {
  const oldest = incidents.reduce((a, b) =>
    new Date(a.opened_at) < new Date(b.opened_at) ? a : b);
  const ageHours = incidentAgeHours(oldest);
  return `RECOVERED: ${exp.label} is producing again (was down ${humanDuration(ageHours)}, cause: ${oldest.cause}).`;
}

module.exports = {
  RESEND_HOURS, LEVEL_UP_AFTER_HOURS, levelForAge, resendIntervalHours, incidentAgeHours,
  findOpenIncident, openIncident, touchIncident, resolveIncidents,
  DELIVERY_STATES, escalationPatch, recordEscalationOutcome,
  shouldEscalate, formatEscalation, formatRecovery, humanDuration,
};
