// api/_lib/worker-pool.js
// ============================================================================
// Worker pool primitives — claim, complete, heartbeat, ensure-N-warm.
//
// Workers are LOGICAL — they're rows in agent_workers, not separate processes.
// The HUD spawn flow (or a future cron) keeps N=3 idle rows per (tenant, role).
// When a task is posted to agent_task_queue, an idle worker claims it
// atomically via a single UPDATE ... WHERE status='idle' RETURNING * pattern.
//
// In the v1 implementation we don't actually have long-lived processes
// pulling tasks (Vercel serverless can't host them cheaply). Instead, the
// /api/agent-task-execute endpoint is invoked once per task, which:
//   1) claims an idle worker (UPDATE atomically)
//   2) calls Anthropic via spawn-with-cache + route-model
//   3) writes result + releases worker
//
// This still gives us:
//   - cache hits (model targets per role are byte-identical between calls)
//   - per-role utilization metrics
//   - dead-worker detection (heartbeat stale = mark dead, replacement spawned)
//   - throughput observability
//
// Owner: Atlas (atlas_5, 2026-06-20 Agent Speed Unlock).
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VALID_ROLES = new Set([
  'atlas','carter','hadley','pierce','sage','ridge','quinn','sterling','jarvis',
]);

const POOL_SIZE_PER_ROLE = parseInt(process.env.AGENT_POOL_SIZE_PER_ROLE || '3', 10);
const HEARTBEAT_STALE_SECONDS = parseInt(process.env.AGENT_HEARTBEAT_STALE_SECONDS || '90', 10);

function assertEnv() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('worker-pool: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing');
  }
}

async function sb(method, path, body) {
  assertEnv();
  const init = {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sb ${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  }
  // Some PATCH/UPDATE responses can be empty when no row matched.
  const t = await res.text();
  if (!t) return [];
  try { return JSON.parse(t); } catch { return []; }
}

/**
 * Ensure POOL_SIZE_PER_ROLE warm workers exist for a (tenant, role).
 * Spawns new rows up to the target. Returns the current pool.
 */
async function ensurePool(tenantId, agentRole, target = POOL_SIZE_PER_ROLE) {
  if (!VALID_ROLES.has(agentRole)) throw new Error(`invalid_role:${agentRole}`);
  const current = await sb('GET',
    `agent_workers?select=*&tenant_id=eq.${tenantId}&agent_role=eq.${agentRole}&status=in.(idle,busy)&order=worker_label.asc`
  );
  if (current.length >= target) return current;

  // Determine next labels — find max existing index for this (tenant, role)
  // including dead workers so we don't reuse a label.
  const all = await sb('GET',
    `agent_workers?select=worker_label&tenant_id=eq.${tenantId}&agent_role=eq.${agentRole}`
  );
  let maxIdx = 0;
  for (const r of all) {
    const m = /-(\d+)$/.exec(r.worker_label || '');
    if (m) maxIdx = Math.max(maxIdx, parseInt(m[1], 10));
  }

  const toCreate = target - current.length;
  const rows = [];
  for (let i = 1; i <= toCreate; i++) {
    rows.push({
      tenant_id: tenantId,
      agent_role: agentRole,
      worker_label: `${agentRole}-worker-${maxIdx + i}`,
      status: 'idle',
    });
  }
  if (rows.length > 0) {
    const inserted = await sb('POST', 'agent_workers', rows);
    return [...current, ...inserted];
  }
  return current;
}

/**
 * Atomically claim one idle worker for the given (tenant, role).
 * Returns the worker row or null if none available.
 */
async function claimIdleWorker(tenantId, agentRole, taskId) {
  // Find one idle worker id first
  const idle = await sb('GET',
    `agent_workers?select=id&tenant_id=eq.${tenantId}&agent_role=eq.${agentRole}&status=eq.idle&limit=1`
  );
  if (!idle || idle.length === 0) return null;
  const workerId = idle[0].id;

  // CAS update — only succeeds if still idle.
  const updated = await sb('PATCH',
    `agent_workers?id=eq.${workerId}&status=eq.idle`,
    {
      status: 'busy',
      current_task_id: taskId,
      last_heartbeat_at: new Date().toISOString(),
    }
  );
  if (!updated || updated.length === 0) {
    // Someone else won the race — bail; caller can retry.
    return null;
  }
  return updated[0];
}

/**
 * Release a worker back to idle. Optionally pass a final heartbeat time.
 */
async function releaseWorker(workerId) {
  return sb('PATCH', `agent_workers?id=eq.${workerId}`, {
    status: 'idle',
    current_task_id: null,
    last_heartbeat_at: new Date().toISOString(),
  });
}

/**
 * Touch the heartbeat on a worker. Workers (or the calling endpoint) should
 * call this periodically while long-running.
 */
async function heartbeat(workerId) {
  return sb('PATCH', `agent_workers?id=eq.${workerId}`, {
    last_heartbeat_at: new Date().toISOString(),
  });
}

/**
 * Mark workers with stale heartbeats as dead. Returns the count marked.
 */
async function reapDeadWorkers(staleSeconds = HEARTBEAT_STALE_SECONDS) {
  const threshold = new Date(Date.now() - staleSeconds * 1000).toISOString();
  const rows = await sb('PATCH',
    `agent_workers?status=in.(idle,busy)&last_heartbeat_at=lt.${encodeURIComponent(threshold)}`,
    { status: 'dead' }
  );
  return rows.length;
}

/**
 * Insert a task on the queue. Returns the row.
 */
async function enqueueTask({
  tenantId, agentRole, prompt, priority = 3, modelOverride, complexityHint,
  parentInstanceId, metadata = {},
}) {
  if (!VALID_ROLES.has(agentRole)) throw new Error(`invalid_role:${agentRole}`);
  if (!prompt || typeof prompt !== 'string') throw new Error('prompt required');
  const rows = await sb('POST', 'agent_task_queue', [{
    tenant_id: tenantId,
    agent_role: agentRole,
    prompt,
    priority,
    model_override: modelOverride || null,
    complexity_hint: complexityHint || null,
    status: 'queued',
    parent_instance_id: parentInstanceId || null,
    metadata,
  }]);
  return rows[0];
}

/**
 * Claim the next eligible task for a role (highest priority first, oldest first).
 * Atomically marks status='in_progress' + claimed_at + assigned_worker_id.
 */
async function claimNextTask(tenantId, agentRole, workerId) {
  const queued = await sb('GET',
    `agent_task_queue?select=id&tenant_id=eq.${tenantId}&agent_role=eq.${agentRole}&status=eq.queued&order=priority.asc,created_at.asc&limit=1`
  );
  if (!queued || queued.length === 0) return null;
  const taskId = queued[0].id;
  const updated = await sb('PATCH',
    `agent_task_queue?id=eq.${taskId}&status=eq.queued`,
    {
      status: 'in_progress',
      assigned_worker_id: workerId,
      claimed_at: new Date().toISOString(),
    }
  );
  if (!updated || updated.length === 0) return null;
  return updated[0];
}

async function completeTask(taskId, result) {
  return sb('PATCH', `agent_task_queue?id=eq.${taskId}`, {
    status: 'done',
    result: result || null,
    completed_at: new Date().toISOString(),
  });
}

async function failTask(taskId, errorMessage) {
  return sb('PATCH', `agent_task_queue?id=eq.${taskId}`, {
    status: 'failed',
    error_message: String(errorMessage || 'unknown').slice(0, 2000),
    completed_at: new Date().toISOString(),
  });
}

module.exports = {
  VALID_ROLES,
  POOL_SIZE_PER_ROLE,
  HEARTBEAT_STALE_SECONDS,
  ensurePool,
  claimIdleWorker,
  releaseWorker,
  heartbeat,
  reapDeadWorkers,
  enqueueTask,
  claimNextTask,
  completeTask,
  failTask,
};
