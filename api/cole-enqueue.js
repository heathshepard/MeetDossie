'use strict';

// api/cole-enqueue.js
// =============================================================================
// Cole/Jarvis async-work enqueue endpoint. Replaces direct Agent-tool spawning
// for any task that is not gating the very next Telegram reply.
//
// POST /api/cole-enqueue
// Headers: Authorization: Bearer ${CRON_SECRET}
// Body:
//   {
//     target_agent: "carter" | "atlas" | "hadley" | "pierce" | "sage"
//                 | "quinn" | "ridge" | "sterling",
//     title: string (max 280 chars),
//     description: string (the task brief; max 8000 chars),
//     priority: 1-5 (1 = highest; default 3),
//     depends_on: optional uuid[] (other agent_queue.id values),
//     venture: optional string (default 'general'),
//     source: optional string (free-text, e.g. 'cole-chat', 'dod', 'memo'),
//     create_future_build: optional boolean (default true) — also create a
//                          jarvis_future_builds row so the HUD shows it.
//   }
//
// Response:
//   { ok: true, queue_id, future_build_id?, target_agent }
//
// OWNER: Atlas, 2026-06-25 (SV-ENG-AGENT-QUEUE-PRODUCER).

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;

const HEATH_TENANT_ID = '0cd05e2f-491f-411f-afe7-f8d3fbbdbff6';

const VALID_AGENTS = new Set([
  'carter', 'atlas', 'hadley', 'pierce', 'sage', 'quinn', 'ridge', 'sterling',
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

  const targetAgent = String(body.target_agent || '').toLowerCase().trim();
  const title       = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  const priority    = Number.isFinite(body.priority) ? Math.max(1, Math.min(5, Math.floor(body.priority))) : 3;
  const dependsOn   = Array.isArray(body.depends_on) ? body.depends_on.filter(x => typeof x === 'string') : [];
  const venture     = (body.venture && String(body.venture).trim()) || 'general';
  const source      = (body.source && String(body.source).trim()) || 'cole-enqueue';
  const createFutureBuild = body.create_future_build === false ? false : true;

  if (!VALID_AGENTS.has(targetAgent)) {
    return res.status(400).json({ ok: false, error: `invalid_target_agent:${targetAgent}` });
  }
  if (!title) {
    return res.status(400).json({ ok: false, error: 'title_required' });
  }
  if (!description) {
    return res.status(400).json({ ok: false, error: 'description_required' });
  }

  // 1. Optionally create the jarvis_future_builds row first so the queue row
  //    can reference its id. Idempotent via source_key UNIQUE constraint
  //    (tenant_id, source_key).
  let futureBuildId = null;
  if (createFutureBuild) {
    const sourceKey = `manual:cole-enqueue:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fbPayload = {
      tenant_id: HEATH_TENANT_ID,
      title: title.slice(0, 280),
      description: description.slice(0, 8000),
      source,
      source_key: sourceKey,
      status: 'building',
      score: priority ? (6 - priority) * 20 : null,
      updated_at: new Date().toISOString(),
    };
    const fb = await sb('jarvis_future_builds', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(fbPayload),
    });
    if (fb.ok && Array.isArray(fb.data) && fb.data[0]) {
      futureBuildId = fb.data[0].id;
    } else {
      // Soft-fail: still proceed with queue insert.
      console.warn('[cole-enqueue] future_build insert failed', fb.status, JSON.stringify(fb.data).slice(0, 200));
    }
  }

  // 2. Insert the agent_queue row.
  const queuePayload = {
    agent_name: targetAgent,
    task_subject: title.slice(0, 280),
    task_brief: description.slice(0, 8000),
    priority,
    depends_on: dependsOn,
    venture,
    status: 'pending',
    metadata: {
      source,
      source_table: futureBuildId ? 'jarvis_future_builds' : null,
      source_id: futureBuildId,
      source_key: futureBuildId ? `jarvis_future_builds:${futureBuildId}` : `cole-enqueue:${Date.now()}`,
      enqueued_at: new Date().toISOString(),
      enqueued_by: 'cole',
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
    future_build_id: futureBuildId,
    target_agent: targetAgent,
    priority,
    depends_on: dependsOn,
  });
};
