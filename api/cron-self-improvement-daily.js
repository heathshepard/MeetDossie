'use strict';

// api/cron-self-improvement-daily.js
// =============================================================================
// SV-ENG-RIDGE-SELF-IMPROVEMENT-DAILY-001 (Ridge, 2026-07-01)
//
// Heath 2026-07-01 07:11 CDT:
//   "I want you to constantly think of ways to improve your intelligence and
//    usefullness to me. How do we make this a constant and ongoing pursuit."
//
// Tier 1 of the self-improvement meta-loop. Fires 5 AM CST (10:00 UTC),
// one hour before the 6 AM autonomous digest so the top candidates can be
// merged into that brief without a second Telegram ping.
//
// What it does:
//   1. Read yesterday's raw signals:
//        - agent_queue rows completed in the last 24h (Heath's response to
//          each, when logged in metadata.correction, is our best correction
//          signal; result_summary + task_brief show punts + permission asks)
//        - autonomous_loop_runs from last 24h (guardrail-tripped +
//          skipped_stuck = friction signals)
//        - cron_runs errors persisting > 6h (something is quietly broken)
//   2. Pattern-match for:
//        - Heath corrections     -> "no ", "stop", "don't", "wrong", "you should have"
//        - Heath frustrations    -> "slow", "too technical", "too many questions", "again?"
//        - Cole/agent punts      -> "I don't have access", "can you check", "want me to"
//        - Permission-asking     -> "should I", "want me to", "OK to", "approve this"
//   3. Insert one self_improvement_signals row per detection
//   4. Roll signals into 0-N self_improvement_candidates rows (concrete
//      change proposals). Impact_score sets order for the 6 AM digest.
//   5. Log the run to self_improvement_runs
//
// DOES NOT auto-apply. Every candidate needs Heath's yes/no in the digest.
//
// SCHEDULE: "0 10 * * *"  (5 AM CDT = 10 UTC)
// AUTH: Bearer ${CRON_SECRET} OR x-vercel-cron
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;

async function sb(pathAndQuery, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// ─── Pattern definitions ─────────────────────────────────────────────────────
// Word-boundary anchored, case-insensitive. Ordered — first match wins so
// "wrong" beats "no" if both appear.

const CORRECTION_PATTERNS = [
  { re: /\b(you should have|you were supposed to|why didn't you)\b/i, theme: 'missed_directive', severity: 5 },
  { re: /\b(that's wrong|that is wrong|wrong answer|got it wrong)\b/i, theme: 'wrong_output', severity: 4 },
  { re: /\bstop( doing| asking)?\b/i, theme: 'stop_pattern', severity: 4 },
  { re: /\bdon't (do|ask|say|send|post|write|use)\b/i, theme: 'dont_pattern', severity: 4 },
  { re: /\bno[,.!?]/i, theme: 'no_correction', severity: 3 },
];

const FRUSTRATION_PATTERNS = [
  { re: /\btoo (long|slow|technical|many questions|verbose)\b/i, theme: 'too_much', severity: 4 },
  { re: /\b(again\?|still\?|why (are you|is it)|same problem)\b/i, theme: 'repeat_frustration', severity: 5 },
  { re: /\b(hurry|faster|come on|just do it)\b/i, theme: 'speed', severity: 3 },
  { re: /\b(brevity|shorter|shorter please|less)\b/i, theme: 'brevity', severity: 3 },
];

const PUNT_PATTERNS = [
  { re: /\b(I don't have access|can't access|no access to)\b/i, theme: 'access_punt', severity: 4 },
  { re: /\b(can you (check|confirm|verify|paste|share))\b/i, theme: 'asked_heath_to_check', severity: 3 },
  { re: /\b(want me to|should I|OK to (proceed|go|ship)|approve this)\b/i, theme: 'permission_ask', severity: 3 },
  { re: /\b(I don't know|I'm not sure|hard to say|might be)\b/i, theme: 'hedging', severity: 2 },
];

// ─── Signal gatherers ────────────────────────────────────────────────────────

async function gatherAgentQueueSignals(since) {
  const signals = [];
  // Pull recent completions — Cole's + agents' own task_brief + result_summary
  // are the best proxy for "what got said in ways that leak punts/permission-asks."
  const q = 'agent_queue?select=id,agent_name,task_subject,task_brief,result_summary,status,completed_at,metadata'
          + `&status=in.(completed,blocked)&completed_at=gte.${encodeURIComponent(since)}&order=completed_at.desc&limit=200`;
  const { ok, data } = await sb(q);
  if (!ok || !Array.isArray(data)) return signals;

  for (const row of data) {
    const summary = String(row.result_summary || '');
    const brief   = String(row.task_brief || '');
    const combined = `${summary}\n${brief}`;
    const meta = row.metadata || {};

    // Explicit Heath correction in metadata (Cole/Jarvis writes this when Heath
    // pushes back on a completion).
    if (meta.heath_correction) {
      signals.push({
        signal_kind: 'heath_correction',
        source: 'agent_queue',
        source_id: row.id,
        verbatim_quote: String(meta.heath_correction).slice(0, 800),
        theme: 'explicit_correction',
        severity: 5,
        notes: `On task "${row.task_subject}" (${row.agent_name})`,
        metadata: { agent: row.agent_name, task_subject: row.task_subject },
      });
    }

    // Scan result_summary for punt / permission-ask / hedging language
    for (const { re, theme, severity } of PUNT_PATTERNS) {
      const m = summary.match(re);
      if (m) {
        const start = Math.max(0, m.index - 120);
        const end   = Math.min(summary.length, m.index + m[0].length + 120);
        signals.push({
          signal_kind: 'cole_punt',
          source: 'agent_queue',
          source_id: row.id,
          verbatim_quote: m[0],
          context_before: summary.slice(start, m.index),
          context_after: summary.slice(m.index + m[0].length, end),
          theme,
          severity,
          notes: `On task "${row.task_subject}" (${row.agent_name})`,
          metadata: { agent: row.agent_name, task_subject: row.task_subject },
        });
        break; // one punt signal per row is enough
      }
    }

    // Blocked = an agent gave up mid-work. Structural signal that the brief
    // was ambiguous or the agent lacked capability.
    if (row.status === 'blocked') {
      signals.push({
        signal_kind: 'agent_correction_needed',
        source: 'agent_queue',
        source_id: row.id,
        verbatim_quote: (summary || '').slice(0, 400),
        theme: 'agent_blocked',
        severity: 4,
        notes: `Agent ${row.agent_name} blocked on "${row.task_subject}"`,
        metadata: { agent: row.agent_name, task_subject: row.task_subject },
      });
    }
  }
  return signals;
}

async function gatherAutonomousLoopSignals(since) {
  const signals = [];
  const q = 'autonomous_loop_runs?select=id,run_ts,signal_source,item_picked,outcome,outcome_reason,notes'
          + `&run_ts=gte.${encodeURIComponent(since)}&order=run_ts.desc&limit=200`;
  const { ok, data } = await sb(q);
  if (!ok || !Array.isArray(data)) return signals;

  // Count guardrail trips per source — clusters mean the guardrail is either
  // over-eager (false positives) or the loop keeps proposing the same off-limits
  // thing (missing memory rule).
  const guardrailTrips = new Map();
  const stuckKeys      = new Map();

  for (const row of data) {
    if (row.outcome === 'skipped_guardrail') {
      const key = String(row.outcome_reason || 'unknown').replace(/^guardrail:/, '');
      guardrailTrips.set(key, (guardrailTrips.get(key) || 0) + 1);
    }
    if (row.outcome === 'skipped_stuck') {
      const key = String(row.item_picked || 'unknown');
      stuckKeys.set(key, (stuckKeys.get(key) || 0) + 1);
    }
  }

  for (const [reason, count] of guardrailTrips) {
    if (count < 2) continue; // one guardrail trip is noise
    signals.push({
      signal_kind: 'repeat_theme',
      source: 'autonomous_loop_runs',
      source_id: null,
      verbatim_quote: null,
      theme: `guardrail_${reason}`,
      severity: Math.min(5, 2 + count),
      notes: `${count} guardrail trips on "${reason}" in last 24h — pattern suggests missing memory rule or loop keeps proposing off-limits work.`,
      metadata: { guardrail: reason, count },
    });
  }

  for (const [key, count] of stuckKeys) {
    signals.push({
      signal_kind: 'agent_correction_needed',
      source: 'autonomous_loop_runs',
      source_id: null,
      theme: 'stuck_loop',
      severity: 5,
      notes: `Loop marked "${key}" stuck ${count}x — needs human review to unblock.`,
      metadata: { item: key, count },
    });
  }

  return signals;
}

async function gatherCronErrorSignals() {
  const signals = [];
  const cutoff6h = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const q = `cron_runs?select=cron_name,last_run,last_status,last_meta&last_status=eq.error&last_run=lt.${encodeURIComponent(cutoff6h)}&limit=25`;
  const { ok, data } = await sb(q);
  if (!ok || !Array.isArray(data)) return signals;

  if (data.length >= 3) {
    // Cluster of persistent failures = observability gap, not one cron issue
    signals.push({
      signal_kind: 'repeat_theme',
      source: 'cron_runs',
      source_id: null,
      theme: 'cron_persistent_failures',
      severity: 5,
      notes: `${data.length} crons stuck in error > 6h. Meta-signal: mission-watchdog alerting may be missing these OR the autonomous loop's cooldowns are too long.`,
      metadata: { count: data.length, sample: data.slice(0, 5).map(r => r.cron_name) },
    });
  }
  return signals;
}

// ─── Candidate drafter ───────────────────────────────────────────────────────
// Roll up signals into concrete Heath-reviewable proposals.

function draftCandidatesFromSignals(signals) {
  const candidates = [];

  // Group by theme for repeat detection
  const byTheme = new Map();
  for (const s of signals) {
    const t = s.theme || 'uncategorized';
    if (!byTheme.has(t)) byTheme.set(t, []);
    byTheme.get(t).push(s);
  }

  for (const [theme, group] of byTheme) {
    const count = group.length;
    const maxSev = group.reduce((m, s) => Math.max(m, s.severity || 0), 0);
    const impact = Math.min(10, Math.round((maxSev * 1.5) + (count * 0.7)));

    // Common shape
    const supporting = group.find(s => s.verbatim_quote)?.verbatim_quote || null;

    switch (theme) {
      case 'explicit_correction':
      case 'missed_directive':
      case 'wrong_output':
      case 'stop_pattern':
      case 'dont_pattern':
        candidates.push({
          change_kind: 'new_memory_rule',
          title: `Lock rule: Heath corrected ${count}x on "${theme}"`,
          rationale: `Heath issued ${count} correction${count>1?'s':''} matching theme "${theme}" in the last 24h (max severity ${maxSev}). Auto-summaries lose these — memory is the only reliable persistent layer.`,
          proposed_change: supporting
            ? `Draft a paramount-tagged feedback_*.md memory rule capturing Heath's verbatim direction: "${supporting.slice(0,240)}". Ridge or Cole writes the rule + adds the index entry after Heath approves.`
            : `Draft a memory rule around the "${theme}" pattern. Ridge or Cole reviews the raw signals in self_improvement_signals to author the rule.`,
          target_path: '.claude/projects/C--Users-Heath-Shepard-Desktop-MeetDossie/memory/feedback_<theme>.md',
          supporting_quote: supporting,
          signal_ids: group.map(s => s._id).filter(Boolean),
          signal_count: count,
          impact_score: impact,
        });
        break;

      case 'too_much':
      case 'brevity':
      case 'speed':
      case 'repeat_frustration':
        candidates.push({
          change_kind: 'rewrite_agent_prompt',
          title: `Reduce friction: ${count} "${theme}" frustration${count>1?'s':''}`,
          rationale: `Heath expressed frustration around "${theme}" ${count} time${count>1?'s':''} in the last 24h. This isn't a one-off — the agent prompts need tightening.`,
          proposed_change: `Audit Cole/Jarvis + the top-3 offending agent prompts. Bias further toward brevity/speed. If already at extreme brevity, the fix is a specific rule (e.g. no bullet lists > 3 items).`,
          target_path: '~/.claude/agents/*.md',
          supporting_quote: supporting,
          signal_ids: group.map(s => s._id).filter(Boolean),
          signal_count: count,
          impact_score: impact,
        });
        break;

      case 'access_punt':
      case 'asked_heath_to_check':
      case 'permission_ask':
      case 'hedging':
        candidates.push({
          change_kind: 'new_memory_rule',
          title: `Reduce punts: ${count} "${theme}" event${count>1?'s':''}`,
          rationale: `Cole/agents punted or asked permission ${count}x on theme "${theme}" in last 24h. Per feedback_autonomous_problem_solving.md + feedback_problem_solver_no_excuses.md, this is the number one anti-pattern.`,
          proposed_change: `Draft a memory rule naming the specific capability gap ("${theme}") + the 3 alternative paths Cole/the agent should have tried before punting.`,
          target_path: '.claude/projects/C--Users-Heath-Shepard-Desktop-MeetDossie/memory/feedback_no_punt_<theme>.md',
          supporting_quote: supporting,
          signal_ids: group.map(s => s._id).filter(Boolean),
          signal_count: count,
          impact_score: impact,
        });
        break;

      case 'agent_blocked':
      case 'stuck_loop':
        candidates.push({
          change_kind: 'rewrite_agent_prompt',
          title: `Agent unblock: ${count} blocked/stuck event${count>1?'s':''}`,
          rationale: `${count} agent tasks either blocked or the autonomous loop got stuck. The brief was ambiguous or the agent lacks a capability.`,
          proposed_change: `Review the blocked task briefs — either (a) tighten the brief template so the agent has enough context, or (b) add a capability (MCP tool, script, memory pointer) so the agent can complete unblocked next time.`,
          target_path: 'api/cron-autonomous-loop.js OR agent_queue task_brief templates',
          supporting_quote: supporting,
          signal_ids: group.map(s => s._id).filter(Boolean),
          signal_count: count,
          impact_score: impact,
        });
        break;

      case 'cron_persistent_failures':
        candidates.push({
          change_kind: 'build_custom_integration',
          title: `Reliability gap: ${count} cron${count>1?'s':''} stuck in error > 6h`,
          rationale: `Multiple crons quietly failing past mission-watchdog's alert window. Either the watchdog thresholds are wrong or a whole class of crons lacks telemetry.`,
          proposed_change: `Audit which crons are failing, cluster by root cause. If shared cause: fix once. If independent: extend cron-mission-watchdog to alert per-cron rather than per-batch.`,
          target_path: 'api/cron-mission-watchdog.js',
          signal_ids: group.map(s => s._id).filter(Boolean),
          signal_count: count,
          impact_score: impact,
        });
        break;

      default:
        // Unknown / low-signal themes — quietly drop rather than pollute the brief
        break;
    }
  }

  // Sort by impact_score desc so digest picks top 3 easily
  candidates.sort((a, b) => b.impact_score - a.impact_score);
  return candidates;
}

// ─── Main handler ────────────────────────────────────────────────────────────

module.exports = withTelemetry('cron-self-improvement-daily', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  const startedAt = Date.now();
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  let signalsScanned = 0;
  let signalsRecorded = 0;
  let candidatesDrafted = 0;
  let outcome = 'ok';
  let outcomeReason = null;

  try {
    // 1) Gather
    const [aqSignals, alSignals, crSignals] = await Promise.all([
      gatherAgentQueueSignals(since),
      gatherAutonomousLoopSignals(since),
      gatherCronErrorSignals(),
    ]);
    const raw = [...aqSignals, ...alSignals, ...crSignals];
    signalsScanned = raw.length;

    // 2) Persist raw signals — returned IDs let us link candidates
    const rowsToInsert = raw.map(s => ({
      tier: 'daily',
      signal_kind: s.signal_kind,
      source: s.source,
      source_id: s.source_id,
      verbatim_quote: s.verbatim_quote,
      context_before: s.context_before,
      context_after: s.context_after,
      theme: s.theme,
      severity: s.severity,
      notes: s.notes,
      metadata: s.metadata || {},
    }));

    let insertedSignals = [];
    if (rowsToInsert.length > 0) {
      const insRes = await sb('self_improvement_signals?select=id,theme', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(rowsToInsert),
      });
      if (insRes.ok && Array.isArray(insRes.data)) {
        insertedSignals = insRes.data;
        signalsRecorded = insertedSignals.length;
        // Attach IDs back to the raw signals in-order so the drafter can reference them
        for (let i = 0; i < raw.length && i < insertedSignals.length; i++) {
          raw[i]._id = insertedSignals[i].id;
        }
      } else {
        outcome = 'error';
        outcomeReason = `signal_insert_failed:${insRes.status}`;
      }
    }

    // 3) Draft candidates
    if (raw.length > 0 && outcome === 'ok') {
      const candidates = draftCandidatesFromSignals(raw);
      const candidateRows = candidates.map(c => ({
        tier: 'daily',
        change_kind: c.change_kind,
        title: c.title,
        rationale: c.rationale,
        proposed_change: c.proposed_change,
        target_path: c.target_path,
        supporting_quote: c.supporting_quote,
        signal_ids: c.signal_ids,
        signal_count: c.signal_count,
        impact_score: c.impact_score,
      }));

      if (candidateRows.length > 0) {
        const cRes = await sb('self_improvement_candidates?select=id', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(candidateRows),
        });
        if (cRes.ok) {
          candidatesDrafted = candidateRows.length;
        } else {
          outcome = 'error';
          outcomeReason = `candidate_insert_failed:${cRes.status}`;
        }
      }
    }

    if (signalsScanned === 0) {
      outcome = 'no_data';
      outcomeReason = 'no_signals_in_window';
    }
  } catch (err) {
    outcome = 'error';
    outcomeReason = (err && err.message) ? err.message.slice(0, 400) : 'crash';
  }

  // 4) Log the run
  await sb('self_improvement_runs?select=id', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      tier: 'daily',
      signals_scanned: signalsScanned,
      signals_recorded: signalsRecorded,
      candidates_drafted: candidatesDrafted,
      outcome,
      outcome_reason: outcomeReason,
      duration_ms: Date.now() - startedAt,
    }),
  });

  return res.status(200).json({
    ok: outcome !== 'error',
    tier: 'daily',
    signals_scanned: signalsScanned,
    signals_recorded: signalsRecorded,
    candidates_drafted: candidatesDrafted,
    outcome,
    outcome_reason: outcomeReason,
  });
});
