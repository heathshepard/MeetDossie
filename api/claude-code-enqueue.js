'use strict';

// api/claude-code-enqueue.js
// =============================================================================
// Producer for the "Heath's Claude Code CLI as a Max-billed worker" dispatch
// pattern. Any batch task (Fable script gen, weekly newsletter draft, sage
// research pass, etc.) that used to hit the pay-per-token Anthropic API can
// enqueue itself here instead. The task waits until Heath's laptop is on and
// the `scripts/claude-code-worker.js` loop is running, then runs under his
// Max subscription (free at the margin).
//
// This is a THIN wrapper over the existing agent_queue table + peek/claim/
// complete endpoints. It exists so callers don't have to know the raw
// metadata contract (task_type + autonomous flag) required for the worker
// to pick it up.
//
// POST /api/claude-code-enqueue
// Headers: Authorization: Bearer ${CRON_SECRET}
// Body:
//   {
//     task_type: "fable_script_gen" | ...  (required — routes to handler)
//     payload: { ...task-specific-fields... },      (required — handler input)
//     title: string,                                (optional — humans see this)
//     description: string,                          (optional — worker prompt)
//     priority: 1-5 (default 4 — background batch work)
//     agent_name: string (default 'atlas' — must be a valid queue agent)
//     idempotency_key: string (optional — if set, dedupes vs existing pending
//                              rows with same key on metadata.idempotency_key)
//   }
//
// Response:
//   { ok: true, queue_id, task_type, dedupSkipped?: bool, dedupExistingId?: uuid }
//
// COST WIN: Anthropic API pricing is ~$3/1M input + $15/1M output for Sonnet
// (Claude 4.5). Max subscription is $200/mo flat. A single Fable script gen
// run consumes ~30k input + ~4k output tokens = ~$0.15 per run. Nightly for
// 30 days = $4.50/mo. Not huge on its own but the pattern scales: same
// dispatcher can drain sage-research (~$0.20/run × 7/week = $5.60/mo),
// weekly newsletter draft (~$0.30 × 4/mo = $1.20/mo), tutorial reels
// (~$0.10 × 2/week = $0.80/mo), etc. Full migration of the ~34 batch
// callers Atlas identified in SV-API-VS-MAX-SPLIT-2026-07-03 = ~$17-21/mo
// off the API bill.
//
// SECURITY: Bearer CRON_SECRET only. This endpoint is server-only. Payload
// is stored verbatim in metadata JSONB so callers should NOT stash secrets
// here — the worker has env access already.
//
// OWNER: Atlas, 2026-07-07 (SV-CLAUDE-CODE-CLI-WORKER).
// =============================================================================

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;

// Task types the worker knows how to handle. Adding a new one requires:
//   1. Adding it to this set
//   2. Adding a handler file in scripts/claude-code-task-handlers/<task_type>.js
//   3. Wiring the handler into the worker's registry
const VALID_TASK_TYPES = new Set([
  'fable_script_gen',
  'echo',   // testing/smoke — echoes the payload back
]);

// Valid queue agents. We default to 'atlas' since the worker is Atlas-owned
// automation infrastructure. The agent_name is mostly a routing label here
// (the actual handler is chosen by task_type).
const VALID_AGENTS = new Set([
  'cole', 'atlas', 'carter', 'sage', 'pierce',
  'hadley', 'quinn', 'sterling', 'ridge',
]);

async function sb(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => { buf += chunk; });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }

  const taskType = String(body.task_type || '').toLowerCase().trim();
  if (!VALID_TASK_TYPES.has(taskType)) {
    return res.status(400).json({
      ok: false,
      error: `invalid_task_type:${taskType}`,
      valid: [...VALID_TASK_TYPES],
    });
  }

  const payload = body.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({ ok: false, error: 'payload_required_object' });
  }

  const agentName = String(body.agent_name || 'atlas').toLowerCase().trim();
  if (!VALID_AGENTS.has(agentName)) {
    return res.status(400).json({ ok: false, error: `invalid_agent_name:${agentName}` });
  }

  const priority = Number.isFinite(body.priority)
    ? Math.max(1, Math.min(5, Math.floor(body.priority)))
    : 4;
  const title = String(body.title || `${taskType} (${new Date().toISOString().slice(0,10)})`).slice(0, 200);
  const description = String(body.description || `Claude Code CLI worker task. task_type=${taskType}. Handler in scripts/claude-code-task-handlers/${taskType}.js reads metadata.payload and writes result_summary.`).slice(0, 8000);
  const idempotencyKey = body.idempotency_key ? String(body.idempotency_key).slice(0, 200) : null;

  // Idempotency check — if an idempotency_key was provided and a pending or
  // in_progress row already carries it, return the existing id instead of
  // creating a new one. Prevents cron double-fires from queuing two Fable
  // runs for the same date.
  if (idempotencyKey) {
    const enc = encodeURIComponent(idempotencyKey);
    const r = await sb(
      `agent_queue?select=id,status&metadata->>idempotency_key=eq.${enc}` +
      `&status=in.(pending,in_progress)&limit=1`
    );
    if (r.ok && Array.isArray(r.data) && r.data.length > 0) {
      return res.status(200).json({
        ok: true,
        queue_id: r.data[0].id,
        task_type: taskType,
        dedupSkipped: true,
        dedupExistingId: r.data[0].id,
        dedupVia: 'idempotency_key',
      });
    }
  }

  const now = new Date().toISOString();
  const queuePayload = {
    agent_name: agentName,
    task_subject: title,
    task_brief: description,
    priority,
    depends_on: [],
    venture: 'general',
    status: 'pending',
    metadata: {
      // These flags are what makes the worker actually pick it up:
      //   autonomous:true    → agent-queue-peek?autonomous_only=1 sees it
      //   task_type          → the worker's routing key
      //   payload            → the handler's input
      autonomous: true,
      task_type: taskType,
      payload,
      idempotency_key: idempotencyKey,
      source: 'claude-code-enqueue',
      enqueued_at: now,
      enqueued_by: 'claude-code-enqueue',
    },
  };

  const ins = await sb('agent_queue', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(queuePayload),
  });
  if (!ins.ok || !Array.isArray(ins.data) || !ins.data[0]) {
    return res.status(500).json({
      ok: false,
      error: `queue_insert_failed:${ins.status}`,
      detail: ins.data,
    });
  }

  return res.status(200).json({
    ok: true,
    queue_id: ins.data[0].id,
    task_type: taskType,
    agent_name: agentName,
    priority,
    idempotency_key: idempotencyKey,
    enqueued_at: now,
  });
};
