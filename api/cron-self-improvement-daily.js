'use strict';

// api/cron-self-improvement-daily.js
// =============================================================================
// SV-ENG-RIDGE-SELF-IMPROVEMENT-DAILY-002 (Ridge, 2026-07-01)
//
// Heath 2026-07-01 07:11 CDT:
//   "I want you to constantly think of ways to improve your intelligence and
//    usefullness to me. How do we make this a constant and ongoing pursuit."
//
// Heath 2026-07-01 07:18 CDT:
//   "I think i want it more daily. I dont want you to grow weekly but daily."
//
// ONE daily cron — no weekly or monthly tiers. All three checks run every
// morning at 5 AM CDT (10:00 UTC), one hour before the 6 AM autonomous digest
// so the top candidates per category can be merged into that one brief.
//
// Three checks in one run:
//
//   1. CONVERSATION REVIEW (yesterday)
//      - agent_queue rows completed in the last 24h (Heath's response in
//        metadata.correction is our best correction signal; result_summary +
//        task_brief show punts + permission asks)
//      - autonomous_loop_runs from last 24h (guardrail-tripped +
//        skipped_stuck = friction signals)
//      - cron_runs errors persisting > 6h (something is quietly broken)
//      Pattern-match for corrections / frustrations / punts.
//
//   2. CAPABILITY SCAN (overnight — was formerly weekly)
//      - access-punt signals from THIS RUN + last 24h
//      - agent_queue result_summary containing "would be easier with",
//        "wish we could", etc.
//      - blocked task rows
//      Cluster by capability keyword. Propose Zapier action enables or
//      custom-integration builds when a bucket >= 2 events.
//
//   3. RULE AUDIT (lightweight — was formerly monthly)
//      - self_improvement_candidates from last 7d — approved themes still
//        recurring (rule not sticking) or rejected themes repeating (drafter
//        false-positive)
//      - agent_queue per-agent blocked rate over last 7d
//      Drafts consolidation / retirement / rewrite candidates.
//
// Each check emits into self_improvement_candidates with tier='daily' so the
// 6 AM digest picks up top 3 per category (change_kind) grouped.
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

// ============================================================================
// CHECK 1 — CONVERSATION REVIEW
// ============================================================================
// Pattern definitions — word-boundary anchored, case-insensitive. Ordered:
// first match wins so "wrong" beats "no" if both appear.

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

async function gatherAgentQueueSignals(since) {
  const signals = [];
  const q = 'agent_queue?select=id,agent_name,task_subject,task_brief,result_summary,status,completed_at,metadata'
          + `&status=in.(completed,blocked)&completed_at=gte.${encodeURIComponent(since)}&order=completed_at.desc&limit=200`;
  const { ok, data } = await sb(q);
  if (!ok || !Array.isArray(data)) return signals;

  for (const row of data) {
    const summary = String(row.result_summary || '');
    const brief   = String(row.task_brief || '');
    const meta = row.metadata || {};

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
        break;
      }
    }

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
    if (count < 2) continue;
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

function draftConversationCandidates(signals) {
  const candidates = [];
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
    const supporting = group.find(s => s.verbatim_quote)?.verbatim_quote || null;

    switch (theme) {
      case 'explicit_correction':
      case 'missed_directive':
      case 'wrong_output':
      case 'stop_pattern':
      case 'dont_pattern':
        candidates.push({
          category: 'conversation_review',
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
          category: 'conversation_review',
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
          category: 'conversation_review',
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
          category: 'conversation_review',
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
          category: 'conversation_review',
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
        break;
    }
  }

  candidates.sort((a, b) => b.impact_score - a.impact_score);
  return candidates;
}

// ============================================================================
// CHECK 2 — CAPABILITY SCAN (formerly weekly, now daily)
// ============================================================================
// Look at last 24h of punt signals + wishlist language + blocked tasks.
// Cluster by capability keyword. Emit Zapier-enable or custom-build candidates
// for buckets that hit >= 2 events in the window.

async function gatherRecentAccessPunts(since) {
  const q = 'self_improvement_signals?select=id,verbatim_quote,notes,metadata,theme'
         + `&theme=in.(access_punt,asked_heath_to_check,permission_ask)`
         + `&detected_at=gte.${encodeURIComponent(since)}&limit=200`;
  const { ok, data } = await sb(q);
  return (ok && Array.isArray(data)) ? data : [];
}

async function gatherRecentWishlist(since) {
  const q = 'agent_queue?select=id,agent_name,task_subject,result_summary'
         + `&completed_at=gte.${encodeURIComponent(since)}`
         + `&result_summary=ilike.*would be easier*&limit=100`;
  const { ok, data } = await sb(q);
  return (ok && Array.isArray(data)) ? data : [];
}

async function gatherRecentBlocked(since) {
  const q = 'agent_queue?select=id,agent_name,task_subject,result_summary,metadata'
         + `&status=eq.blocked&created_at=gte.${encodeURIComponent(since)}&limit=50`;
  const { ok, data } = await sb(q);
  return (ok && Array.isArray(data)) ? data : [];
}

function clusterByCapability(accessPunts, wishlistRows, blockedRows) {
  const buckets = new Map();

  function add(bucketKey, evidence) {
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, { count: 0, evidence: [] });
    const b = buckets.get(bucketKey);
    b.count += 1;
    if (b.evidence.length < 5) b.evidence.push(evidence);
  }

  const CAPABILITY_KEYWORDS = [
    { key: 'gmail_send',       re: /\bsend (an? )?email\b|\bgmail\b/i },
    { key: 'calendar_book',    re: /\b(schedule|book|calendar|meeting invite)\b/i },
    { key: 'stripe_action',    re: /\bstripe\b|\bsubscription\b|\bcheckout\b/i },
    { key: 'facebook_group',   re: /\bfb group\b|\bfacebook group\b/i },
    { key: 'linkedin',         re: /\blinkedin\b/i },
    { key: 'x_twitter',        re: /\btwitter\b|\bpost.*(x|X)\b/i },
    { key: 'phone_call',       re: /\b(call|voice call|ring)\b/i },
    { key: 'sms_send',         re: /\b(sms|text message)\b/i },
    { key: 'docusign',         re: /\bdocusign\b|\bdocuseal\b/i },
    { key: 'zoom_recording',   re: /\bzoom recording\b|\btranscript\b/i },
    { key: 'drive_upload',     re: /\bgoogle drive\b/i },
    { key: 'canva_design',     re: /\bcanva\b/i },
  ];

  const all = [
    ...accessPunts.map(r => ({ text: `${r.verbatim_quote || ''} ${r.notes || ''}`, source: 'signal', id: r.id })),
    ...wishlistRows.map(r => ({ text: `${r.task_subject || ''} ${r.result_summary || ''}`, source: 'wishlist', id: r.id })),
    ...blockedRows.map(r => ({ text: `${r.task_subject || ''} ${r.result_summary || ''}`, source: 'blocked', id: r.id })),
  ];

  for (const item of all) {
    for (const { key, re } of CAPABILITY_KEYWORDS) {
      if (re.test(item.text)) {
        add(key, item);
        break;
      }
    }
  }

  return buckets;
}

function draftCapabilityCandidates(buckets) {
  const candidates = [];

  const ZAPIER_MAP = {
    gmail_send:     { app: 'Gmail',              action: 'send_email' },
    calendar_book:  { app: 'Google Calendar',    action: 'create_event' },
    stripe_action:  { app: 'Stripe',             action: 'create_customer_or_charge' },
    docusign:       { app: 'DocuSign',           action: 'send_envelope' },
    drive_upload:   { app: 'Google Drive',       action: 'upload_file' },
    canva_design:   { app: 'Canva',              action: 'export_design' },
  };

  for (const [key, { count, evidence }] of buckets) {
    if (count < 2) continue;

    const impact = Math.min(10, 3 + count);
    const supporting = evidence[0]?.text?.slice(0, 240) || null;

    if (ZAPIER_MAP[key]) {
      const { app, action } = ZAPIER_MAP[key];
      candidates.push({
        category: 'capability_scan',
        change_kind: 'enable_zapier_action',
        title: `Enable Zapier action: ${app} / ${action} (${count} gap${count>1?'s':''} in last 24h)`,
        rationale: `${count} agent tasks in the last 24h either punted or wished for ${app} capability. Zapier already integrates ${app} — enabling the ${action} action is a low-friction unlock.`,
        proposed_change: `Call mcp__claude_ai_Zapier__discover_zapier_actions for ${app}, then enable_zapier_action for the "${action}" step. Add a memory pointer at reference_capabilities.md so agents know it exists.`,
        target_path: 'Zapier catalog + reference_capabilities.md',
        supporting_quote: supporting,
        signal_count: count,
        impact_score: impact,
      });
    } else {
      candidates.push({
        category: 'capability_scan',
        change_kind: 'build_custom_integration',
        title: `Capability gap: ${key.replace(/_/g,' ')} (${count} event${count>1?'s':''} in last 24h)`,
        rationale: `${count} tasks in the last 24h hit a "${key}" capability gap. No off-the-shelf Zapier action fits — needs a custom integration or MCP wrapper.`,
        proposed_change: `Scope a build for "${key}". Options: (a) native API integration, (b) Playwright script if UI-only, (c) MCP server if it should be tool-accessible to all agents. Cost + effort estimate required before Heath approves.`,
        target_path: 'scripts/ OR api/_lib/',
        supporting_quote: supporting,
        signal_count: count,
        impact_score: impact,
      });
    }
  }

  candidates.sort((a, b) => b.impact_score - a.impact_score);
  return candidates;
}

// ============================================================================
// CHECK 3 — RULE AUDIT (formerly monthly, now daily lightweight)
// ============================================================================
// Rolling 7-day window (light enough to run daily). Detects:
//   - Rules approved but same theme still recurring -> rule not sticking
//   - Rules rejected repeatedly -> drafter false-positive
//   - Themes with 20+ signals in 7d never rolled to candidate -> drafter gap
//   - Agents with elevated blocked rate over 7d -> prompt rewrite

async function gatherRecentCandidates(since) {
  const q = `self_improvement_candidates?select=id,tier,change_kind,title,heath_decision,heath_decided_at,heath_note,signal_count,impact_score,drafted_at,target_path`
         + `&drafted_at=gte.${encodeURIComponent(since)}&order=drafted_at.desc&limit=500`;
  const { ok, data } = await sb(q);
  return (ok && Array.isArray(data)) ? data : [];
}

async function gatherRecentSignalsForAudit(since) {
  const q = `self_improvement_signals?select=id,theme,signal_kind,severity,detected_at`
         + `&detected_at=gte.${encodeURIComponent(since)}&order=detected_at.desc&limit=2000`;
  const { ok, data } = await sb(q);
  return (ok && Array.isArray(data)) ? data : [];
}

async function gatherRecentAgentStats(since) {
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

function draftAuditCandidates(candidates, signals, agentStats) {
  const drafts = [];

  const approvedThemes = new Set();
  for (const c of candidates) {
    if (c.heath_decision === 'approved') {
      const m = c.title.match(/"([^"]+)"/);
      if (m) approvedThemes.add(m[1]);
    }
  }

  const signalCountsByTheme = new Map();
  for (const s of signals) {
    const t = s.theme || 'uncategorized';
    signalCountsByTheme.set(t, (signalCountsByTheme.get(t) || 0) + 1);
  }

  // 1) Rule not sticking
  for (const t of approvedThemes) {
    const post = signalCountsByTheme.get(t) || 0;
    if (post >= 5) {
      drafts.push({
        category: 'rule_audit',
        change_kind: 'rewrite_agent_prompt',
        title: `Rule not sticking: "${t}" — ${post} recurrences in last 7d despite approval`,
        rationale: `A memory rule on theme "${t}" was approved recently, but ${post} more signals on the same theme fired since. Rule text isn't enforcing behavior — needs sharpening.`,
        proposed_change: `Re-read the rule. Options: (a) move rule from feedback_*.md to a runtime enforcement gate (per Ridge's operational-rules-enforcement charter), (b) rewrite as a paramount-tagged rule with an example, (c) add the rule directly to the offending agent's system prompt.`,
        target_path: 'memory rule + affected agent .md file',
        signal_count: post,
        impact_score: Math.min(10, 5 + Math.floor(post / 5)),
      });
    }
  }

  // 2) Drafter false-positive — theme rejected 2+ times
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
        category: 'rule_audit',
        change_kind: 'rewrite_agent_prompt',
        title: `Drafter false-positive: "${t}" rejected ${count}x`,
        rationale: `The daily drafter proposed rules on theme "${t}" ${count} times recently and Heath rejected each. The pattern-matcher regexes catching this theme are too broad.`,
        proposed_change: `Update PUNT_PATTERNS / CORRECTION_PATTERNS / FRUSTRATION_PATTERNS in cron-self-improvement-daily.js to exclude the false-positive shape. Add a comment noting Heath rejected this class ${count} times.`,
        target_path: 'api/cron-self-improvement-daily.js',
        signal_count: count,
        impact_score: 6,
      });
    }
  }

  // 3) Coverage gap — theme with high signal count but no candidate drafted
  const themesWithCandidates = new Set();
  for (const c of candidates) {
    const m = c.title.match(/"([^"]+)"/);
    if (m) themesWithCandidates.add(m[1]);
  }
  for (const [theme, count] of signalCountsByTheme) {
    if (count < 20) continue;
    if (themesWithCandidates.has(theme)) continue;
    drafts.push({
      category: 'rule_audit',
      change_kind: 'rewrite_agent_prompt',
      title: `Drafter coverage gap: theme "${theme}" (${count} signals, 0 candidates in 7d)`,
      rationale: `Theme "${theme}" logged ${count} signals in the last 7d but the drafter never rolled it into a candidate. Either the theme's severity is always <3 or the drafter's switch statement doesn't handle it.`,
      proposed_change: `Add a case for theme="${theme}" in draftConversationCandidates() in cron-self-improvement-daily.js.`,
      target_path: 'api/cron-self-improvement-daily.js',
      signal_count: count,
      impact_score: 5,
    });
  }

  // 4) Agent quality — >20% blocked rate over 7d
  for (const [agent, s] of Object.entries(agentStats)) {
    if (s.total < 10) continue;
    const blockedRate = s.blocked / s.total;
    if (blockedRate > 0.20) {
      drafts.push({
        category: 'rule_audit',
        change_kind: 'rewrite_agent_prompt',
        title: `Agent quality: ${agent} blocked ${(blockedRate*100).toFixed(0)}% (${s.blocked}/${s.total}) in last 7d`,
        rationale: `${agent} was blocked on ${(blockedRate*100).toFixed(0)}% of their tasks in the last 7 days. The system prompt likely lacks a capability, tool pointer, or process for a common blocker.`,
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

// ============================================================================
// MAIN HANDLER
// ============================================================================

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
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const since7d  = new Date(Date.now() -  7 * 24 * 3600 * 1000).toISOString();

  let signalsScanned = 0;
  let signalsRecorded = 0;
  let candidatesDrafted = 0;
  const categoryCounts = { conversation_review: 0, capability_scan: 0, rule_audit: 0 };
  let outcome = 'ok';
  let outcomeReason = null;

  try {
    // ─── CHECK 1: CONVERSATION REVIEW ───────────────────────────────────────
    const [aqSignals, alSignals, crSignals] = await Promise.all([
      gatherAgentQueueSignals(since24h),
      gatherAutonomousLoopSignals(since24h),
      gatherCronErrorSignals(),
    ]);
    const rawConversation = [...aqSignals, ...alSignals, ...crSignals];
    signalsScanned += rawConversation.length;

    // Persist raw signals for the audit check to see
    let insertedSignals = [];
    if (rawConversation.length > 0) {
      const rowsToInsert = rawConversation.map(s => ({
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
      const insRes = await sb('self_improvement_signals?select=id,theme', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(rowsToInsert),
      });
      if (insRes.ok && Array.isArray(insRes.data)) {
        insertedSignals = insRes.data;
        signalsRecorded += insertedSignals.length;
        for (let i = 0; i < rawConversation.length && i < insertedSignals.length; i++) {
          rawConversation[i]._id = insertedSignals[i].id;
        }
      } else {
        outcome = 'error';
        outcomeReason = `signal_insert_failed:${insRes.status}`;
      }
    }

    const conversationCandidates = (outcome === 'ok')
      ? draftConversationCandidates(rawConversation)
      : [];

    // ─── CHECK 2: CAPABILITY SCAN ───────────────────────────────────────────
    let capabilityCandidates = [];
    if (outcome === 'ok') {
      const [accessPunts, wishlist, blocked] = await Promise.all([
        gatherRecentAccessPunts(since24h),
        gatherRecentWishlist(since24h),
        gatherRecentBlocked(since24h),
      ]);
      signalsScanned += accessPunts.length + wishlist.length + blocked.length;

      const buckets = clusterByCapability(accessPunts, wishlist, blocked);
      capabilityCandidates = draftCapabilityCandidates(buckets);

      // Persist meta-signal rows (one per bucket >= 2) so future audits see them
      const metaSignalRows = [];
      for (const [key, { count }] of buckets) {
        if (count < 2) continue;
        metaSignalRows.push({
          tier: 'daily',
          signal_kind: 'tool_gap',
          theme: `capability_${key}`,
          severity: Math.min(5, 2 + Math.floor(count / 2)),
          notes: `${count} tasks needed "${key}" in last 24h`,
          metadata: { capability: key, count },
        });
      }
      if (metaSignalRows.length > 0) {
        const sRes = await sb('self_improvement_signals?select=id', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(metaSignalRows),
        });
        if (sRes.ok) signalsRecorded += metaSignalRows.length;
      }
    }

    // ─── CHECK 3: RULE AUDIT (7d rolling) ───────────────────────────────────
    let auditCandidates = [];
    if (outcome === 'ok') {
      const [pastCandidates, pastSignals, agentStats] = await Promise.all([
        gatherRecentCandidates(since7d),
        gatherRecentSignalsForAudit(since7d),
        gatherRecentAgentStats(since7d),
      ]);
      signalsScanned += pastCandidates.length + pastSignals.length;
      auditCandidates = draftAuditCandidates(pastCandidates, pastSignals, agentStats);
    }

    // ─── PERSIST ALL CANDIDATES ─────────────────────────────────────────────
    const allCandidates = [...conversationCandidates, ...capabilityCandidates, ...auditCandidates];
    if (allCandidates.length > 0 && outcome === 'ok') {
      const candidateRows = allCandidates.map(c => ({
        tier: 'daily',
        category: c.category,
        change_kind: c.change_kind,
        title: c.title,
        rationale: c.rationale,
        proposed_change: c.proposed_change,
        target_path: c.target_path,
        supporting_quote: c.supporting_quote || null,
        signal_ids: c.signal_ids || [],
        signal_count: c.signal_count,
        impact_score: c.impact_score,
      }));

      const cRes = await sb('self_improvement_candidates?select=id', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(candidateRows),
      });
      if (cRes.ok) {
        candidatesDrafted = candidateRows.length;
        categoryCounts.conversation_review = conversationCandidates.length;
        categoryCounts.capability_scan     = capabilityCandidates.length;
        categoryCounts.rule_audit          = auditCandidates.length;
      } else if (cRes.status === 400 || cRes.status === 422) {
        // Fallback for schemas that don't yet have a "category" column —
        // retry without it so we don't lose today's candidates.
        const fallbackRows = candidateRows.map(r => {
          const { category, ...rest } = r;
          return rest;
        });
        const retryRes = await sb('self_improvement_candidates?select=id', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(fallbackRows),
        });
        if (retryRes.ok) {
          candidatesDrafted = fallbackRows.length;
          categoryCounts.conversation_review = conversationCandidates.length;
          categoryCounts.capability_scan     = capabilityCandidates.length;
          categoryCounts.rule_audit          = auditCandidates.length;
        } else {
          outcome = 'error';
          outcomeReason = `candidate_insert_failed:${retryRes.status}`;
        }
      } else {
        outcome = 'error';
        outcomeReason = `candidate_insert_failed:${cRes.status}`;
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
    candidates_by_category: categoryCounts,
    outcome,
    outcome_reason: outcomeReason,
  });
});
