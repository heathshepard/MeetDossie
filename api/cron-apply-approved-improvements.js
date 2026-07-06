'use strict';

// api/cron-apply-approved-improvements.js
// =============================================================================
// SV-ENG-ATLAS-APPLY-APPROVED-IMPROVEMENTS-001 (Atlas, 2026-07-06)
//
// Heath's daily digest surfaces self-improvement candidates. He replies
// "approve 1 3 5" in Telegram (parsed by telegram-webhook.js →
// heath_decision='approved'). Until now, nothing consumed those approved
// rows — applied_at was never written. This cron fixes that.
//
// Runs hourly. Picks up to N approved-but-not-applied candidates and routes
// them by change_kind:
//
//   memory_rule / prompt_rewrite / code_change / build_custom_integration
//     → Enqueue an agent_queue row for Atlas with the proposed_change as
//       the task_brief. Stamp applied_at NOW and applied_notes with the
//       queue_id + agent + timestamp. When the agent finishes and writes
//       result_summary with a commit SHA, cron-reconcile-future-builds
//       (or a future reconciler) can back-fill applied_commit_sha.
//
//   tool_enablement
//     → Insert a heath_actions row asking Heath to enable / connect / sign
//       up for the tool. Set applied_at (dispatch is complete — Heath's the
//       blocker now, that's fine).
//
// Never touches candidates without heath_decision='approved'. Never touches
// candidates that already have applied_at set.
//
// AUTH: Bearer ${CRON_SECRET} OR x-vercel-cron
// SCHEDULE: "17 * * * *"  (17 past the hour, every hour)
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID          = process.env.TELEGRAM_CHAT_ID;

const MAX_PER_TICK = 5;   // Cap dispatches per run — avoid flooding agent queue.

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

async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false };
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text.slice(0, 4090),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    return { ok: r.ok };
  } catch (err) {
    console.error('[apply-approved] tg error:', err && err.message);
    return { ok: false };
  }
}

// Map change_kind → the agent that should ship it.
// Everything code / infra goes to Atlas per role-expansion 2026-06-18.
function pickAgent(change_kind) {
  const k = String(change_kind || '').toLowerCase();
  if (k === 'tool_enablement') return null;   // Heath-action instead of agent
  if (k === 'memory_rule')     return 'atlas';
  if (k === 'prompt_rewrite')  return 'atlas';
  if (k === 'code_change')     return 'atlas';
  if (k === 'build_custom_integration') return 'atlas';
  return 'atlas';   // Default: Atlas
}

function priorityFromImpact(impact_score) {
  const s = Number(impact_score) || 0;
  if (s >= 8) return 1;    // high
  if (s >= 5) return 2;    // medium
  return 3;                // low
}

async function enqueueAgentTask(candidate, agent) {
  const subject = `Apply improvement: ${String(candidate.title || 'unnamed').slice(0, 100)}`;
  const briefLines = [
    `Self-improvement candidate approved by Heath.`,
    `Candidate ID: ${candidate.id}`,
    `Kind: ${candidate.change_kind}`,
    candidate.target_path ? `Target: ${candidate.target_path}` : null,
    ``,
    `Title: ${candidate.title}`,
    ``,
    `Rationale:`,
    String(candidate.rationale || '').slice(0, 2000),
    ``,
    `Proposed change:`,
    String(candidate.proposed_change || '').slice(0, 4000),
    ``,
    `Instructions:`,
    `1. Implement the change on staging.`,
    `2. Run APV where applicable.`,
    `3. Merge to main + tag.`,
    `4. In result_summary, include the commit SHA(s) so we can back-fill applied_commit_sha.`,
    `5. If the change is inapplicable (already shipped, obsolete), say so in result_summary — do not force-apply.`,
  ].filter(Boolean).join('\n');

  const insertRes = await sb('agent_queue', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      agent_name: agent,
      task_subject: subject,
      task_brief: briefLines,
      priority: priorityFromImpact(candidate.impact_score),
      venture: 'meetdossie',
      status: 'pending',
      metadata: {
        source: 'self_improvement_candidate',
        candidate_id: candidate.id,
        change_kind: candidate.change_kind,
        impact_score: candidate.impact_score,
      },
    }),
  });
  if (!insertRes.ok || !Array.isArray(insertRes.data) || insertRes.data.length === 0) {
    return { ok: false, error: `agent_queue insert failed status=${insertRes.status}` };
  }
  return { ok: true, queue_id: insertRes.data[0].id };
}

async function createHeathAction(candidate) {
  const title = `Enable/connect tool: ${String(candidate.title || 'unnamed').slice(0, 120)}`;
  const body = [
    `Self-improvement candidate approved.`,
    ``,
    String(candidate.rationale || '').slice(0, 500),
    ``,
    `Proposed action:`,
    String(candidate.proposed_change || '').slice(0, 1000),
  ].join('\n');

  const res = await sb('heath_actions', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      title,
      body,
      source: 'self_improvement_apply',
      priority: 'medium',
      status: 'pending',
      action_type: 'tool_enablement',
      payload: {
        candidate_id: candidate.id,
        change_kind: candidate.change_kind,
      },
    }),
  });
  if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) {
    return { ok: false, error: `heath_actions insert failed status=${res.status}` };
  }
  return { ok: true, action_id: res.data[0].id };
}

async function markCandidateApplied(candidateId, notes) {
  const patchRes = await sb(
    `self_improvement_candidates?id=eq.${candidateId}&applied_at=is.null`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        applied_at: new Date().toISOString(),
        applied_notes: notes,
      }),
    }
  );
  return patchRes.ok;
}

async function markCandidateFailed(candidateId, notes) {
  // Not a schema state — we store the failure in applied_notes but leave
  // applied_at null so the next tick will re-try. But cap retries: if
  // applied_notes already contains 3 failure lines, mark applied_at anyway
  // so we stop hammering. Fetch first.
  const cur = await sb(`self_improvement_candidates?id=eq.${candidateId}&select=applied_notes`);
  const existing = String(cur?.data?.[0]?.applied_notes || '');
  const failCount = (existing.match(/\[FAIL /g) || []).length;
  const stamp = `[FAIL ${new Date().toISOString()}] ${notes}`;
  const combined = existing ? `${existing}\n${stamp}` : stamp;
  const patch = { applied_notes: combined };
  if (failCount + 1 >= 3) {
    patch.applied_at = new Date().toISOString(); // Give up after 3 failures.
  }
  await sb(`self_improvement_candidates?id=eq.${candidateId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

// ─── Main handler ────────────────────────────────────────────────────────────

module.exports = withTelemetry('cron-apply-approved-improvements', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  const dryRun = req.query && (req.query.dry_run === '1' || req.query.dry_run === 'true');

  // Pull approved-but-not-applied, oldest decision first (FIFO fairness).
  const r = await sb(
    'self_improvement_candidates'
    + '?select=id,title,rationale,proposed_change,change_kind,target_path,impact_score,heath_decided_at,applied_notes'
    + '&heath_decision=eq.approved'
    + '&applied_at=is.null'
    + '&order=heath_decided_at.asc'
    + `&limit=${MAX_PER_TICK}`
  );
  if (!r.ok) {
    return res.status(500).json({ ok: false, error: 'candidates_fetch_failed', status: r.status });
  }
  const candidates = Array.isArray(r.data) ? r.data : [];

  if (candidates.length === 0) {
    return res.status(200).json({ ok: true, picked: 0, dispatched: [] });
  }

  if (dryRun) {
    return res.status(200).json({
      ok: true,
      dry_run: true,
      picked: candidates.length,
      preview: candidates.map(c => ({
        id: c.id,
        change_kind: c.change_kind,
        agent: pickAgent(c.change_kind),
        title: c.title,
      })),
    });
  }

  const dispatched = [];
  const failed = [];

  for (const cand of candidates) {
    const agent = pickAgent(cand.change_kind);
    try {
      if (agent === null) {
        // tool_enablement → heath_actions row
        const created = await createHeathAction(cand);
        if (!created.ok) {
          await markCandidateFailed(cand.id, created.error || 'heath_action_create_failed');
          failed.push({ id: cand.id, reason: created.error });
          continue;
        }
        await markCandidateApplied(cand.id, JSON.stringify({
          dispatched_to: 'heath_actions',
          action_id: created.action_id,
          at: new Date().toISOString(),
        }));
        dispatched.push({ id: cand.id, target: 'heath_actions', ref: created.action_id, kind: cand.change_kind });
      } else {
        const enq = await enqueueAgentTask(cand, agent);
        if (!enq.ok) {
          await markCandidateFailed(cand.id, enq.error || 'agent_queue_enqueue_failed');
          failed.push({ id: cand.id, reason: enq.error });
          continue;
        }
        await markCandidateApplied(cand.id, JSON.stringify({
          dispatched_to: 'agent_queue',
          agent,
          queue_id: enq.queue_id,
          at: new Date().toISOString(),
        }));
        dispatched.push({ id: cand.id, target: 'agent_queue', agent, ref: enq.queue_id, kind: cand.change_kind });
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error('[apply-approved] dispatch error for', cand.id, msg);
      await markCandidateFailed(cand.id, msg);
      failed.push({ id: cand.id, reason: msg });
    }
  }

  // Notify Heath ONLY if anything actually dispatched (avoid noise).
  if (dispatched.length > 0) {
    const lines = [];
    lines.push(`<b>Applying ${dispatched.length} approved improvement${dispatched.length === 1 ? '' : 's'}:</b>`);
    for (const d of dispatched) {
      const c = candidates.find(x => x.id === d.id);
      const short = String(c?.title || d.id).slice(0, 80);
      const routing = d.target === 'heath_actions' ? 'needs your action' : `→ ${d.agent}`;
      lines.push(`• ${short} <i>(${routing})</i>`);
    }
    if (failed.length > 0) {
      lines.push(`<i>${failed.length} failed — will retry.</i>`);
    }
    await tg(lines.join('\n'));
  }

  return res.status(200).json({
    ok: true,
    picked: candidates.length,
    dispatched_count: dispatched.length,
    failed_count: failed.length,
    dispatched,
    failed,
  });
});
