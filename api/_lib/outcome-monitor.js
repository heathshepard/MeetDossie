'use strict';

// api/_lib/outcome-monitor.js
//
// The orchestrator. Pure logic + Supabase, no HTTP handler and no Telegram, so
// it can be run end-to-end from a script against live data without sending
// anything (see scripts/outcome-monitor-verify.js).
//
// THE LOOP, per expectation:
//   measure (system of record)
//     -> met?   close any open incident, emit a recovery line, done
//     -> gap?   classify the cause
//               -> remediate what the cause maps to
//               -> RE-MEASURE
//                  -> fixed?  record 'remediated', close the incident, stay quiet
//                  -> still broken? open/advance the incident and decide escalation
//
// The re-measure is the part that matters. A remediation that reports success
// but does not move the number is the same lie this system was built to catch,
// so the only evidence we accept is the count going up.
//
// Owner: Atlas, 2026-09-25

const { sb, loadExpectations, measure } = require('./outcome-expectations.js');
const { classify, countQueue } = require('./outcome-causes.js');
const { remediate } = require('./outcome-remediation.js');
const esc = require('./outcome-escalation.js');

async function recordCheck(row) {
  try {
    await sb('outcome_checks', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([row]),
    });
  } catch { /* telemetry must never break the monitor */ }
}

function summarizeRuns(runs) {
  if (!runs || !runs.length) return 'nothing applicable';
  return runs.map((r) => {
    if (!r.attempted) return `${r.remediation}: skipped (${r.skipped_reason})`;
    return `${r.remediation}: ${r.ok ? 'ok' : 'failed'}${r.changed ? ` (${r.changed} rows)` : ''}`;
  }).join('; ');
}

/**
 * Evaluate one expectation all the way through.
 * Returns a plain object; the caller decides what to do with .alert.
 */
async function evaluate(exp, opts = {}) {
  const { dryRun = false } = opts;
  const started = Date.now();
  const out = {
    key: exp.key, label: exp.label, pipeline: exp.pipeline,
    expected: Number(exp.min_count), actual: null, status: 'error',
    cause: null, remediation: null, alert: null, recovery: null,
  };

  const m = await measure(exp, opts);
  out.actual = m.actual;
  out.query = m.query;

  if (m.error) {
    out.status = 'error';
    out.error = m.error;
    await recordCheck({ expectation_key: exp.key, expected: out.expected, actual: -1,
                        status: 'error', cause: 'check_error',
                        cause_detail: { error: m.error }, duration_ms: Date.now() - started });
    return out;
  }

  // ── Healthy ───────────────────────────────────────────────────────────────
  if (m.met) {
    out.status = 'met';
    const closed = dryRun ? [] : await esc.resolveIncidents(exp.key, 'recovered');
    if (closed.length) out.recovery = esc.formatRecovery(exp, closed);
    await recordCheck({ expectation_key: exp.key, expected: out.expected, actual: m.actual,
                        status: 'met', duration_ms: Date.now() - started });
    return out;
  }

  // ── Gap: diagnose ─────────────────────────────────────────────────────────
  const cause = await classify(exp);
  out.cause = cause;

  // ── Gap: repair, then RE-MEASURE ──────────────────────────────────────────
  const rem = await remediate(exp, cause, { dryRun });
  out.remediation = rem;

  let remeasured = null;
  if (rem.changed) {
    remeasured = await measure(exp, opts);
    out.actual_after_remediation = remeasured.actual;
    if (remeasured.met) {
      out.status = 'remediated';
      const closed = dryRun ? [] : await esc.resolveIncidents(exp.key, 'remediated');
      if (closed.length) out.recovery = esc.formatRecovery(exp, closed);
      await recordCheck({
        expectation_key: exp.key, expected: out.expected, actual: remeasured.actual,
        status: 'remediated', cause: cause.cause, cause_detail: cause.detail,
        remediation: rem, duration_ms: Date.now() - started,
      });
      return out; // fixed itself. Heath hears nothing. That is the goal.
    }
  }

  // ── Still broken: incident + escalation decision ──────────────────────────
  out.status = 'gap';
  const backlog = await countQueue(exp).catch(() => null);
  // The true outage age, straight from the system of record.
  const outageHours = (remeasured && remeasured.outage_hours != null)
    ? remeasured.outage_hours : m.outage_hours;
  out.last_produced_at = m.last_produced_at;
  out.outage_hours = outageHours;

  let incident;
  let isNew = false;
  const existing = await esc.findOpenIncident(exp.key, cause.cause);
  if (dryRun) {
    // Simulate without writing, so a verification run cannot pollute state or
    // burn a real escalation slot.
    isNew = !existing;
    incident = existing || {
      id: null, expectation_key: exp.key, cause: cause.cause,
      opened_at: new Date().toISOString(),
      escalation_level: outageHours === null ? 0 : esc.levelForAge(outageHours),
      escalation_count: 0, consecutive_failures: 1, backlog_count: backlog,
      detail: { ...cause.detail, outage_hours: outageHours },
    };
  } else if (existing) {
    incident = await esc.touchIncident(existing, { ...cause.detail, outage_hours: outageHours }, backlog, outageHours);
  } else {
    isNew = true;
    incident = await esc.openIncident(exp, cause, cause.detail, backlog, outageHours);
  }
  out.incident = incident;

  const decision = esc.shouldEscalate(exp, incident, { isNew, outageHours });
  out.escalation_decision = decision;

  if (decision.escalate) {
    out.alert = esc.formatEscalation(exp, incident, cause, {
      actual: m.actual, expected: out.expected, outage_hours: outageHours,
      remediation_summary: summarizeRuns(rem.runs),
    });
    if (!dryRun && incident && incident.id) await esc.markEscalated(incident);
  }

  await recordCheck({
    expectation_key: exp.key, expected: out.expected, actual: m.actual,
    status: 'gap', cause: cause.cause, cause_detail: cause.detail,
    remediation: rem, escalated: !!decision.escalate,
    duration_ms: Date.now() - started,
  });
  return out;
}

/** Run the whole declared set. */
async function runAll(opts = {}) {
  const exps = await loadExpectations(opts);
  const results = [];
  for (const exp of exps) {
    try {
      results.push(await evaluate(exp, opts));
    } catch (e) {
      results.push({ key: exp.key, label: exp.label, status: 'error', error: e.message });
    }
  }
  return {
    checked_at: new Date().toISOString(),
    expectations: exps.length,
    met: results.filter((r) => r.status === 'met').length,
    remediated: results.filter((r) => r.status === 'remediated').length,
    gaps: results.filter((r) => r.status === 'gap').length,
    errors: results.filter((r) => r.status === 'error').length,
    alerts: results.filter((r) => r.alert).map((r) => r.alert),
    recoveries: results.filter((r) => r.recovery).map((r) => r.recovery),
    results,
  };
}

module.exports = { evaluate, runAll, summarizeRuns };
