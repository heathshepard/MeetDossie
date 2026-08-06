'use strict';

// api/_lib/agent-queue-complete-core.js
//
// Shared completion + audit-routing + work-stealing logic. Used by:
//   - api/agent-queue-complete.js (HTTP wrapper — poller calls this)
//   - api/cron-agent-queue-dispatch.js (in-process — no self-HTTP-call
//     needed, lets the dispatch loop steal+process the next task for the
//     same agent within the same Vercel invocation, bounded by wall-clock
//     budget)
//
// See api/agent-queue-complete.js header for the full audit-loop state
// machine writeup (normal completion -> pending_audit, audit verdict ->
// completed | pending w/ retry cap -> blocked + escalate).
//
// Owner: Atlas, 2026-08-06 (SV-ENG-AGENT-QUEUE-AUDIT-LOOP).

const MAX_AUDIT_RETRIES = 3; // matches the Carter/Quinn 3-retry convention in CLAUDE.md

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
  } catch (e) {
    console.warn('[agent-queue-complete-core] telegram failed:', e.message);
  }
}

// Atomic claim of the next ready task for `agentName`.
async function stealNext(supabase, agentName, sessionId) {
  const { data: ready } = await supabase
    .from('agent_queue_ready')
    .select('id, agent_name, task_subject, task_brief, priority, venture, depends_on, metadata, created_at')
    .eq('agent_name', agentName)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1);

  if (!ready || ready.length === 0) return null;
  const task = ready[0];
  const now = new Date().toISOString();
  const meta = { ...(task.metadata || {}), _claim_session: sessionId, _claim_ts: now, _stolen_by_complete: true };

  const { data: claimed, error } = await supabase
    .from('agent_queue')
    .update({ status: 'in_progress', started_at: now, metadata: meta })
    .eq('id', task.id)
    .eq('status', 'pending')
    .select('id, agent_name, task_subject, task_brief, priority, venture, depends_on, metadata, started_at')
    .single();

  if (error || !claimed) return null; // lost the race — fine, normal claim path picks it up

  await supabase
    .from('agent_state')
    .update({ status: 'working', current_task_id: claimed.id, last_active_at: now, last_heartbeat_at: now })
    .eq('agent_name', agentName);

  return claimed;
}

const ACCEPTED = new Set(['completed', 'blocked', 'cancelled', 'pending']);

/**
 * completeTask — the shared audit-routing + work-stealing operation.
 *
 * @param {object} supabase  service-role supabase-js client
 * @param {object} opts      { id, status, result_summary, completed_by_agent_session, metadata, steal }
 *   steal: boolean, default true. Set false to skip the work-steal step
 *   (dispatch's own loop does the stealing explicitly to control timing).
 * @returns {object} { ok, error?, status?, task?, next_pending_for_agent?, stolen_next? }
 */
async function completeTask(supabase, opts) {
  const id = String(opts.id || '').trim();
  if (!id) return { ok: false, status: 400, error: 'id required' };

  let status = String(opts.status || 'completed').toLowerCase().trim();
  if (!ACCEPTED.has(status)) {
    return { ok: false, status: 400, error: `status must be one of: ${[...ACCEPTED].join(', ')}` };
  }

  const result_summary = String(opts.result_summary || '').slice(0, 4000);
  const completed_by_agent_session = opts.completed_by_agent_session
    ? String(opts.completed_by_agent_session).slice(0, 200)
    : null;
  const extraMeta = (opts.metadata && typeof opts.metadata === 'object') ? opts.metadata : {};
  const doSteal = opts.steal !== false;

  const { data: existing, error: loadErr } = await supabase
    .from('agent_queue')
    .select('id, agent_name, status, metadata')
    .eq('id', id)
    .single();

  if (loadErr || !existing) return { ok: false, status: 404, error: 'task not found' };

  const existingMeta = existing.metadata || {};
  const isAuditCompletion = existingMeta._is_audit_claim === true;
  let merged = { ...existingMeta, ...extraMeta };
  let escalated = false;

  if (isAuditCompletion) {
    // ── AUDIT VERDICT ──────────────────────────────────────────────────
    if (status === 'completed') {
      merged._audit_verdict = 'pass';
      merged._audit_passed_at = new Date().toISOString();
    } else if (status === 'pending') {
      const failCount = Number(existingMeta._audit_fail_count || 0) + 1;
      merged._audit_fail_count = failCount;
      merged._audit_failure_reason = String(extraMeta._audit_failure_reason || result_summary || 'unspecified').slice(0, 1000);
      merged._audit_last_fail_at = new Date().toISOString();
      merged._is_audit_claim = false;
      merged._audit_claimed_by = null;

      if (failCount > MAX_AUDIT_RETRIES) {
        status = 'blocked';
        merged._escalate_to_heath = true;
        escalated = true;
      }
    }
  } else if (existing.status === 'in_progress' && status === 'completed') {
    // ── NORMAL WORKER COMPLETION ─────────────────────────────────────
    const skipAudit = existing.agent_name === 'quinn'
      || existingMeta.skip_audit === true
      || extraMeta.skip_audit === true;
    if (!skipAudit) {
      status = 'pending_audit';
      merged._audit_requested_at = new Date().toISOString();
    }
  }

  const now = new Date().toISOString();
  const { data: updated, error: updErr } = await supabase
    .from('agent_queue')
    .update({
      status,
      completed_at: (status === 'completed' || status === 'blocked' || status === 'cancelled') ? now : null,
      completed_by_agent_session,
      result_summary,
      metadata: merged,
    })
    .eq('id', id)
    .select('id, agent_name, task_subject, status, completed_at, result_summary, metadata')
    .single();

  if (updErr) return { ok: false, status: 500, error: updErr.message };

  const workerAgent = isAuditCompletion
    ? (existingMeta._audit_claimed_by || 'quinn')
    : existing.agent_name;

  await supabase
    .from('agent_state')
    .update({ status: 'idle', current_task_id: null, last_active_at: now, last_heartbeat_at: now })
    .eq('agent_name', workerAgent)
    .eq('current_task_id', existing.id);

  if (escalated) {
    await tg(
      `[agent queue] "${updated.task_subject}" (${existing.agent_name}) failed audit ${MAX_AUDIT_RETRIES + 1}x. ` +
        `Escalated to blocked — needs Heath. Reason: ${merged._audit_failure_reason || 'see result_summary'}`,
    );
  }

  let stolen = null;
  if (doSteal) {
    const sessionId = completed_by_agent_session || `steal_${Date.now()}`;
    stolen = await stealNext(supabase, workerAgent, sessionId);
  }

  const { count: nextPending } = await supabase
    .from('agent_queue')
    .select('id', { count: 'exact', head: true })
    .eq('agent_name', workerAgent)
    .eq('status', 'pending');

  return {
    ok: true,
    status: 200,
    task: updated,
    worker_agent: workerAgent,
    next_pending_for_agent: nextPending || 0,
    stolen_next: stolen,
  };
}

module.exports = { completeTask, stealNext, MAX_AUDIT_RETRIES };
