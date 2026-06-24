// api/agent-task-execute.js
// ============================================================================
// POST /api/agent-task-execute?task_id=<uuid>
//      OR
// POST /api/agent-task-execute?agent_role=atlas  (claims next queued task)
//
// Executes a queued task against Anthropic via the cached spawn helper +
// model router. Atomically claims a worker; releases on completion.
//
// Auth: Bearer Supabase JWT (Jarvis-tenant scoped).
//
// Body (optional):
//   {
//     system_static?: string,   // override the role's default static system
//   }
//
// Returns:
//   200 { ok: true, task_id, model, cache_metrics, output_text }
//   404 no task / no worker
//   500
//
// In v1 this is invoked one-shot per task. Future: a cron tick at ~5s
// interval polls per role and dispatches to this endpoint, giving a
// true pull model.
//
// Owner: Atlas (atlas_5, 2026-06-20 Agent Speed Unlock).

import { verifySupabaseToken } from './_middleware/auth.js';
const Anthropic = require('@anthropic-ai/sdk');
const { messagesCreateCached } = require('./_lib/spawn-with-cache');
const { routeModel } = require('./_lib/route-model');
const {
  ensurePool, claimIdleWorker, releaseWorker, heartbeat,
  claimNextTask, completeTask, failTask, VALID_ROLES,
} = require('./_lib/worker-pool');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Per-role default static system prompts. Kept short on purpose — the
// real per-task instruction goes in the queued prompt. The point of the
// static prefix is to be byte-identical across calls so caching kicks in.
const ROLE_STATIC_SYSTEM = {
  atlas:    'You are Atlas, Head of Platform Engineering at Shepard Ventures. You execute infrastructure and product-shipping tasks precisely. You verify outputs by reading rendered output, never by assuming. You report what you observed, not what you expected. Reports are 1-5 sentences.',
  carter:   'You are Carter, Product Engineer at Shepard Ventures. You draft code changes for Atlas to ship. You never push to main directly. You produce minimal, reviewable diffs.',
  hadley:   'You are Hadley, General Counsel at Shepard Ventures. You cite primary sources (TAC / TRELA / Tex. Prop. Code / TREC) for every claim. You never fabricate citations.',
  pierce:   'You are Pierce, Growth + Customer Success at Shepard Ventures. You draft warm, founder-direct outreach. You never quantify breadth or blame third parties.',
  sage:     'You are Sage, Head of Social Media at Shepard Ventures. You draft platform-optimized posts in Dossie\'s warm, capable voice.',
  ridge:    'You are Ridge, Reliability Engineer at Shepard Ventures. You hunt for SLO breaches and dead crons. You report failures by error class.',
  quinn:    'You are Quinn, QA at Shepard Ventures. You sign in to staging, execute the customer flow, and report observations of the rendered output.',
  sterling: 'You are Sterling, Markets + Portfolio Strategy. You surface verifiable information; you never predict.',
  jarvis:   'You are Jarvis, Heath Shepard\'s personal AI chief of staff. You decompose goals and orchestrate agents.',
};

export const config = { api: { bodyParser: true }, maxDuration: 60 };

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

async function sb(method, path, body) {
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
  const t = await res.text();
  if (!t) return [];
  try { return JSON.parse(t); } catch { return []; }
}

async function resolveTenantId(authUserId) {
  const rows = await sb('GET',
    `jarvis_users?select=tenant_id&auth_user_id=eq.${authUserId}&limit=1`);
  return (rows && rows[0] && rows[0].tenant_id) || null;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ ok: false, error: 'anthropic_key_missing' });
  }

  let authUser;
  try {
    authUser = await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: err.message });
  }
  const tenantId = await resolveTenantId(authUser.userId);
  if (!tenantId) return res.status(403).json({ ok: false, error: 'no_jarvis_tenant' });

  const q = req.query || {};
  const taskIdArg = q.task_id;
  const roleArg = q.agent_role;
  const body = req.body || {};

  let task = null;
  let agentRole = null;

  try {
    if (taskIdArg) {
      // Direct task id — load it and claim if still queued.
      const rows = await sb('GET',
        `agent_task_queue?select=*&id=eq.${taskIdArg}&tenant_id=eq.${tenantId}&limit=1`);
      if (!rows || rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'task_not_found' });
      }
      task = rows[0];
      agentRole = task.agent_role;
      if (task.status !== 'queued') {
        return res.status(409).json({ ok: false, error: 'task_already_claimed', status: task.status });
      }
    } else if (roleArg) {
      if (!VALID_ROLES.has(roleArg)) {
        return res.status(400).json({ ok: false, error: 'invalid_agent_role' });
      }
      agentRole = roleArg;
    } else {
      return res.status(400).json({ ok: false, error: 'task_id_or_agent_role_required' });
    }

    // Make sure the pool exists for this role
    await ensurePool(tenantId, agentRole);

    // Claim an idle worker (placeholder taskId — will be patched once task claimed)
    let worker = await claimIdleWorker(tenantId, agentRole, task ? task.id : null);
    if (!worker) {
      return res.status(503).json({ ok: false, error: 'no_idle_worker' });
    }

    // If we don't have a task yet, claim the next queued one for this role.
    if (!task) {
      task = await claimNextTask(tenantId, agentRole, worker.id);
      if (!task) {
        await releaseWorker(worker.id);
        return res.status(404).json({ ok: false, error: 'no_queued_task' });
      }
      // Update worker's current_task_id now that we have it
      await sb('PATCH', `agent_workers?id=eq.${worker.id}`, { current_task_id: task.id });
    } else {
      // We had the task id from the caller — atomically claim it now.
      const claimed = await sb('PATCH',
        `agent_task_queue?id=eq.${task.id}&status=eq.queued`,
        { status: 'in_progress', assigned_worker_id: worker.id, claimed_at: new Date().toISOString() });
      if (!claimed || claimed.length === 0) {
        await releaseWorker(worker.id);
        return res.status(409).json({ ok: false, error: 'task_claim_lost_race' });
      }
      task = claimed[0];
    }

    // Pick model via router. complexity_hint > model_override > router > default.
    const { model, reason: routeReason } = routeModel({
      role: agentRole,
      task: task.prompt,
      override: task.model_override,
      complexity: task.complexity_hint,
    });

    // System: per-role default static + (optional) per-task body override.
    const systemStatic = body.system_static || ROLE_STATIC_SYSTEM[agentRole] || '';

    // Heartbeat once before the call (long-running)
    await heartbeat(worker.id);

    let result;
    try {
      result = await messagesCreateCached(anthropic, {
        model,
        systemStatic,
        messages: [{ role: 'user', content: task.prompt }],
        max_tokens: 4000,
        metadata: {
          tenant_id: tenantId,
          agent_role: agentRole,
          instance_id: worker.worker_label,
          task_id: task.id,
          endpoint: 'agent-task-execute',
        },
      });
    } catch (err) {
      console.error('[agent-task-execute] anthropic failed:', err.message);
      await failTask(task.id, err.message);
      await releaseWorker(worker.id);
      return res.status(500).json({ ok: false, error: 'anthropic_failed', detail: err.message });
    }

    const textBlock = (result.content || []).find((b) => b.type === 'text');
    const outputText = textBlock ? textBlock.text : '';

    await completeTask(task.id, {
      output_text: outputText,
      model,
      route_reason: routeReason,
      cache_metrics: result.cache_metrics,
    });
    await releaseWorker(worker.id);

    return res.status(200).json({
      ok: true,
      task_id: task.id,
      worker_id: worker.id,
      worker_label: worker.worker_label,
      agent_role: agentRole,
      model,
      route_reason: routeReason,
      cache_metrics: result.cache_metrics,
      output_text: outputText,
    });
  } catch (err) {
    console.error('[agent-task-execute] failed:', err.message);
    return res.status(500).json({ ok: false, error: 'execute_failed', detail: err.message });
  }
}
