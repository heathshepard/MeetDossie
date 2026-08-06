'use strict';

// api/cole-dispatch-start.js
// =============================================================================
// Live-interactive-dispatch start call. Separate from api/cole-enqueue.js
// (the async producer, which writes status='pending' and waits for a cron
// worker to claim it). This endpoint is for a task that is ALREADY RUNNING —
// e.g. Cole's own interactive session spawning a subagent (Atlas/Carter/etc)
// right now — and just needs a live agent_queue row so it shows up on the
// Jarvis Instances panel while it works. Inserts directly as in_progress,
// skipping the pending/claim dance.
//
// POST /api/cole-dispatch-start
// Headers: Authorization: Bearer ${CRON_SECRET}
// Body:
//   {
//     agent_name: "cole" | "atlas" | "carter" | "sage" | "pierce"
//               | "hadley" | "quinn" | "sterling" | "ridge",
//     task_subject: string (required, max 200 chars — DB CHECK constraint),
//     venture: optional string, default 'general'
//              (one of dossie|paralegal|personal-agents|shepard-ventures|general),
//     task_brief: optional string (defaults to task_subject; DB requires
//                 NOT NULL and this call has no separate long brief to give it),
//   }
//
// Response 200:
//   { ok: true, id, agent_name, task_subject, venture, started_at }
//
// Completion: POST /api/cole-dispatch-complete with { id, status, result_summary }.
//
// SAFETY NET — orphan cleanup for rows a completion call never reaches:
//   1. cron-agent-queue-dispatch.js's 15-minute self-heal sweep SKIPS rows
//      tagged metadata._live_dispatch=true (see that file — added alongside
//      this endpoint 2026-08-06). Without that exclusion a live session
//      running longer than 15 minutes would get silently reset to 'pending'
//      out from under it every ~2 minutes, which is wrong — these rows are
//      supervised by a real running session, not a dead async worker.
//   2. cron-agent-queue-orphan-reset.js's 4-hour cutoff is UNCHANGED and DOES
//      apply to these rows — it has no live-dispatch exemption and doesn't
//      need one. Any live dispatch still in_progress after 4h with no
//      completion call is genuinely dead and gets reset to 'pending' like
//      any other orphan. That's the intended safety net for this path too.
//
// Audit loop: metadata.skip_audit=true is set at creation. A live interactive
// dispatch is already supervised in real time by the session that spawned
// it — routing it through the pending_audit -> Quinn verdict loop on
// completion would be redundant. See api/_lib/agent-queue-complete-core.js.
//
// agent_state is intentionally NOT touched by this endpoint (no
// current_task_id / status='working' write). That table is the real
// picker's source of truth for "is this agent free to claim the next async
// task" — overwriting it from a live-dispatch call that isn't going through
// the picker risks a false "busy" reading that blocks real queue work.
// Completion is similarly a no-op against agent_state (see
// agent-queue-complete-core.js's current_task_id-guarded update).
//
// OWNER: Atlas, 2026-08-06 (SV-ENG-AGENT-QUEUE-LIVE-DISPATCH, part 2 of the
// live per-agent Jarvis panel work).

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;

const VALID_AGENTS = new Set([
  'cole', 'atlas', 'carter', 'sage', 'pierce', 'hadley', 'quinn', 'sterling', 'ridge',
]);
const VALID_VENTURES = new Set([
  'dossie', 'paralegal', 'personal-agents', 'shepard-ventures', 'general',
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

  const agentName   = String(body.agent_name || '').toLowerCase().trim();
  const taskSubject = String(body.task_subject || '').trim();
  const venture      = (body.venture && String(body.venture).trim()) || 'general';
  const taskBrief    = (body.task_brief && String(body.task_brief).trim()) || taskSubject;

  if (!VALID_AGENTS.has(agentName)) {
    return res.status(400).json({ ok: false, error: `invalid_agent_name:${agentName}` });
  }
  if (!taskSubject) {
    return res.status(400).json({ ok: false, error: 'task_subject_required' });
  }
  if (taskSubject.length > 200) {
    return res.status(400).json({ ok: false, error: 'task_subject_too_long_max_200' });
  }
  if (!VALID_VENTURES.has(venture)) {
    return res.status(400).json({ ok: false, error: `invalid_venture:${venture}` });
  }

  const nowIso = new Date().toISOString();
  const payload = {
    agent_name: agentName,
    task_subject: taskSubject,
    task_brief: taskBrief,
    priority: 1, // live sessions are already running — highest priority if anything ever looks at it
    venture,
    status: 'in_progress',
    started_at: nowIso,
    metadata: {
      source: 'cole-live-dispatch',
      _live_dispatch: true,
      skip_audit: true,
      started_by: 'cole-interactive-session',
      enqueued_at: nowIso,
    },
  };

  const ins = await sb('agent_queue', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });

  if (!ins.ok || !Array.isArray(ins.data) || !ins.data[0]) {
    return res.status(500).json({ ok: false, error: `insert_failed:${ins.status}`, detail: ins.data });
  }

  const row = ins.data[0];
  return res.status(200).json({
    ok: true,
    id: row.id,
    agent_name: row.agent_name,
    task_subject: row.task_subject,
    venture: row.venture,
    started_at: row.started_at,
  });
};
