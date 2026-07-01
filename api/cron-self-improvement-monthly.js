'use strict';

// api/cron-self-improvement-monthly.js
// =============================================================================
// SV-ENG-RIDGE-SELF-IMPROVEMENT-MONTHLY-001 (Ridge, 2026-07-01)
//
// Tier 3 of the self-improvement meta-loop. Fires on the 1st of every
// month at 8 AM CST (13:00 UTC).
//
// What it does:
//   1. Read the last 30 days of:
//        - self_improvement_candidates (approved / rejected / superseded)
//        - self_improvement_signals grouped by theme
//        - autonomous_loop_runs (dispatch success rate)
//        - agent_queue completions (per-agent quality signal)
//   2. Identify:
//        - Rules approved but themes still recurring   -> rule needs sharpening
//        - Rules rejected repeatedly                    -> theme is a false pattern
//          (Handled here as rejected clusters)
//        - Themes with 20+ signals never rolled to a candidate -> gap in drafter
//        - Agents with elevated blocked/correction rate -> prompt rewrite needed
//   3. Draft consolidation / retirement / rewrite candidates
//      change_kind = 'consolidate_rules' | 'retire_memory_rule' | 'rewrite_agent_prompt'
//   4. Log run to self_improvement_runs
//
// DOES NOT auto-modify memory or agent files. Every proposal needs Heath's
// yes/no in the 6 AM digest on the 1st.
//
// SCHEDULE: "0 13 1 * *"  (8 AM CDT on 1st = 13 UTC)
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

async function gatherLastMonthCandidates(since) {
  const q = `self_improvement_candidates?select=id,tier,change_kind,title,heath_decision,heath_decided_at,heath_note,signal_count,impact_score,drafted_at,target_path`
         + `&drafted_at=gte.${encodeURIComponent(since)}&order=drafted_at.desc&limit=500`;
  const { ok, data } = await sb(q);
  return (ok && Array.isArray(data)) ? data : [];
}

async function gatherLastMonthSignals(since) {
  const q = `self_improvement_signals?select=id,theme,signal_kind,severity,detected_at`
         + `&detected_at=gte.${encodeURIComponent(since)}&order=detected_at.desc&limit=2000`;
  const { ok, data } = await sb(q);
  return (ok && Array.isArray(data)) ? data : [];
}

async function gatherAgentQualityStats(since) {
  const q = `agent_queue?select=agent_name,status`
         + `&completed_at=gte.${encodeURIComponent(since)}&limit=2000`;
  const { ok, data } = await sb(q);
  if (!ok || !Array.isArray(data)) return {};
  const stats = {};
  for (const r of data) {
    const a = r.agent_name;
    if (!stats[a]) stats[a] = { total: 0, blocked: 0, completed: 0 };
    stats[a].total += 1;
    if (r.status === 'blocked')   stats[a].blocked   += 1;
    if (r.status === 'completed') stats[a].completed += 1;
  }
  return stats;
}

// ─── Analysis ────────────────────────────────────────────────────────────────

function draftMonthlyCandidates(candidates, signals, agentStats) {
  const drafts = [];

  // 1) Recurring themes despite approved rules — approved candidate exists on
  //    theme X but new signals still coming in on theme X.
  const approvedThemes = new Set();
  for (const c of candidates) {
    if (c.heath_decision === 'approved') {
      // Best-effort theme extraction from title
      const m = c.title.match(/"([^"]+)"/);
      if (m) approvedThemes.add(m[1]);
    }
  }

  const signalCountsByTheme = new Map();
  for (const s of signals) {
    const t = s.theme || 'uncategorized';
    signalCountsByTheme.set(t, (signalCountsByTheme.get(t) || 0) + 1);
  }

  for (const t of approvedThemes) {
    const post = signalCountsByTheme.get(t) || 0;
    if (post >= 5) {
      drafts.push({
        change_kind: 'rewrite_agent_prompt',
        title: `Rule not sticking: "${t}" — ${post} recurrences this month despite approval`,
        rationale: `A memory rule on theme "${t}" was approved this month, but ${post} more signals on the same theme fired since. Rule text isn't enforcing behavior — needs sharpening.`,
        proposed_change: `Re-read the rule. Options: (a) move rule from feedback_*.md to a runtime enforcement gate (per Ridge's operational-rules-enforcement charter), (b) rewrite as a paramount-tagged rule with an example, (c) add the rule directly to the offending agent's system prompt.`,
        target_path: 'memory rule + affected agent .md file',
        signal_count: post,
        impact_score: Math.min(10, 5 + Math.floor(post / 5)),
      });
    }
  }

  // 2) Rejected clusters — theme rejected 2+ times means the drafter's
  //    pattern-matcher is producing false positives.
  const rejectedThemes = new Map();
  for (const c of candidates) {
    if (c.heath_decision === 'rejected') {
      const m = c.title.match(/"([^"]+)"/);
      const t = m ? m[1] : c.change_kind;
      rejectedThemes.set(t, (rejectedThemes.get(t) || 0) + 1);
    }
  }
  for (const [t, count] of rejectedThemes) {
    if (count >= 2) {
      drafts.push({
        change_kind: 'rewrite_agent_prompt',
        title: `Drafter false-positive: "${t}" rejected ${count}x`,
        rationale: `The daily/weekly drafter proposed rules on theme "${t}" ${count} times this month and Heath rejected each. The pattern-matcher regexes catching this theme are too broad.`,
        proposed_change: `Update PUNT_PATTERNS / CORRECTION_PATTERNS / FRUSTRATION_PATTERNS in cron-self-improvement-daily.js to exclude the false-positive shape. Add a comment noting Heath rejected this class ${count} times.`,
        target_path: 'api/cron-self-improvement-daily.js',
        signal_count: count,
        impact_score: 6,
      });
    }
  }

  // 3) Never-fired candidates — themes with high signal count but no candidate
  //    got drafted -> drafter has a coverage gap.
  const themesWithCandidates = new Set();
  for (const c of candidates) {
    const m = c.title.match(/"([^"]+)"/);
    if (m) themesWithCandidates.add(m[1]);
  }
  for (const [theme, count] of signalCountsByTheme) {
    if (count < 20) continue;
    if (themesWithCandidates.has(theme)) continue;
    drafts.push({
      change_kind: 'rewrite_agent_prompt',
      title: `Drafter coverage gap: theme "${theme}" (${count} signals, 0 candidates)`,
      rationale: `Theme "${theme}" logged ${count} signals this month but the drafter never rolled it into a candidate. Either the theme's severity is always <3 or the drafter's switch statement doesn't handle it.`,
      proposed_change: `Add a case for theme="${theme}" in draftCandidatesFromSignals() in cron-self-improvement-daily.js.`,
      target_path: 'api/cron-self-improvement-daily.js',
      signal_count: count,
      impact_score: 5,
    });
  }

  // 4) Agent quality — >20% blocked rate means that agent's prompt needs work
  for (const [agent, s] of Object.entries(agentStats)) {
    if (s.total < 10) continue;
    const blockedRate = s.blocked / s.total;
    if (blockedRate > 0.20) {
      drafts.push({
        change_kind: 'rewrite_agent_prompt',
        title: `Agent quality: ${agent} blocked ${(blockedRate*100).toFixed(0)}% (${s.blocked}/${s.total})`,
        rationale: `${agent} was blocked on ${(blockedRate*100).toFixed(0)}% of their tasks this month. The system prompt likely lacks a capability, tool pointer, or process for a common blocker.`,
        proposed_change: `Read the last 10 blocked ${agent} tasks. Identify the common blocker. Add a "when you hit X, do Y" section to ~/.claude/agents/${agent}.md.`,
        target_path: `~/.claude/agents/${agent}.md`,
        signal_count: s.blocked,
        impact_score: Math.min(9, 4 + Math.round(blockedRate * 10)),
      });
    }
  }

  drafts.sort((a, b) => b.impact_score - a.impact_score);
  return drafts;
}

// ─── Main handler ────────────────────────────────────────────────────────────

module.exports = withTelemetry('cron-self-improvement-monthly', async function handler(req, res) {
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
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  let signalsScanned = 0;
  let candidatesDrafted = 0;
  let outcome = 'ok';
  let outcomeReason = null;

  try {
    const [pastCandidates, pastSignals, agentStats] = await Promise.all([
      gatherLastMonthCandidates(since),
      gatherLastMonthSignals(since),
      gatherAgentQualityStats(since),
    ]);

    signalsScanned = pastCandidates.length + pastSignals.length;

    if (signalsScanned === 0) {
      outcome = 'no_data';
      outcomeReason = 'no_month_data';
    } else {
      const drafts = draftMonthlyCandidates(pastCandidates, pastSignals, agentStats);

      if (drafts.length > 0) {
        const rows = drafts.map(c => ({
          tier: 'monthly',
          change_kind: c.change_kind,
          title: c.title,
          rationale: c.rationale,
          proposed_change: c.proposed_change,
          target_path: c.target_path,
          signal_ids: [],
          signal_count: c.signal_count,
          impact_score: c.impact_score,
        }));
        const cRes = await sb('self_improvement_candidates?select=id', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(rows),
        });
        if (cRes.ok) {
          candidatesDrafted = rows.length;
        } else {
          outcome = 'error';
          outcomeReason = `candidate_insert_failed:${cRes.status}`;
        }
      }
    }
  } catch (err) {
    outcome = 'error';
    outcomeReason = (err && err.message) ? err.message.slice(0, 400) : 'crash';
  }

  await sb('self_improvement_runs?select=id', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      tier: 'monthly',
      signals_scanned: signalsScanned,
      signals_recorded: 0, // monthly reads, doesn't add raw signals
      candidates_drafted: candidatesDrafted,
      outcome,
      outcome_reason: outcomeReason,
      duration_ms: Date.now() - startedAt,
    }),
  });

  return res.status(200).json({
    ok: outcome !== 'error',
    tier: 'monthly',
    signals_scanned: signalsScanned,
    candidates_drafted: candidatesDrafted,
    outcome,
    outcome_reason: outcomeReason,
  });
});
