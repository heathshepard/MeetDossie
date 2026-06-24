// api/agent-task-enqueue.js
// ============================================================================
// POST /api/agent-task-enqueue
//
// Adds a task to agent_task_queue. Returns the queued row id. Idempotency
// via optional metadata.idempotency_key (caller-provided; we don't enforce
// uniqueness in v1 — callers should dedupe upstream).
//
// Body:
//   {
//     agent_role: "atlas" | "carter" | ...,
//     prompt: string,                  // the task instructions
//     priority?: 1..5 (default 3),
//     model_override?: "haiku"|"sonnet"|"opus"|"claude-...-id",
//     complexity_hint?: "simple"|"standard"|"hard",
//     parent_instance_id?: uuid,       // optional jarvis_agent_instances.id
//     metadata?: { ... }
//   }
//
// Auth: Bearer Supabase JWT, tenant resolved server-side.
//
// Returns:
//   200 { ok: true, task: { id, agent_role, status, ... } }
//   400 invalid input
//   401 / 403 / 500
//
// Owner: Atlas (atlas_5, 2026-06-20 Agent Speed Unlock).

import { verifySupabaseToken } from './_middleware/auth.js';
const { enqueueTask, ensurePool, VALID_ROLES } = require('./_lib/worker-pool');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const config = { api: { bodyParser: true }, maxDuration: 10 };

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

async function resolveTenantId(authUserId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/jarvis_users?select=tenant_id&auth_user_id=eq.${authUserId}&limit=1`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!r.ok) return null;
  const rows = await r.json();
  return (rows && rows[0] && rows[0].tenant_id) || null;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  let authUser;
  try {
    authUser = await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: err.message });
  }

  const tenantId = await resolveTenantId(authUser.userId);
  if (!tenantId) return res.status(403).json({ ok: false, error: 'no_jarvis_tenant' });

  const body = req.body || {};
  const {
    agent_role, prompt, priority, model_override, complexity_hint,
    parent_instance_id, metadata,
  } = body;

  if (!agent_role || !VALID_ROLES.has(agent_role)) {
    return res.status(400).json({ ok: false, error: 'invalid_agent_role', valid: Array.from(VALID_ROLES) });
  }
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ ok: false, error: 'prompt_required' });
  }

  try {
    // Make sure the pool exists for this role — first enqueue on a fresh tenant
    // will lazy-spawn the workers. Non-fatal if it fails (the executor will
    // do it again).
    await ensurePool(tenantId, agent_role).catch((e) => {
      console.warn('[agent-task-enqueue] ensurePool soft-fail:', e.message);
    });

    const task = await enqueueTask({
      tenantId,
      agentRole: agent_role,
      prompt: prompt.trim(),
      priority: Number.isInteger(priority) ? priority : 3,
      modelOverride: model_override || null,
      complexityHint: complexity_hint || null,
      parentInstanceId: parent_instance_id || null,
      metadata: metadata || {},
    });

    return res.status(200).json({ ok: true, task });
  } catch (err) {
    console.error('[agent-task-enqueue] failed:', err.message);
    return res.status(500).json({ ok: false, error: 'enqueue_failed', detail: err.message });
  }
}
