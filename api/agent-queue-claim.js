// Vercel Serverless Function: /api/agent-queue-claim
//
// POST — atomically claim the next ready task for an agent.
//
// Used by:
//   1. The local Cole Claude Code session, polling every ~30s with
//      { agent: "any" } to pick up whatever's free and spawn it locally.
//   2. /api/cron-agent-queue-tick, which calls this internally per idle agent
//      to mark tasks in_progress before spawning server-side.
//   3. Manual debugging — Heath can curl with { agent: "carter" } to claim
//      Carter's next task and see what's at the top of his queue.
//
// Auth: Bearer ${CRON_SECRET} (this is the server-only path — never user-fronted).
//
// Body:
//   { agent: "carter" | "atlas" | ... | "any" }
//
// Behavior:
//   - If agent is named: claim its highest-priority ready task.
//   - If agent === "any": pick the highest-priority ready task across ALL
//     agents whose agent_state is currently idle (so we don't double-book).
//   - Sets task.status='in_progress', task.started_at=now(), task.metadata._claim_session.
//   - Updates agent_state: status='working', current_task_id=task.id, last_active_at=now().
//   - Idempotent: if nothing is ready, returns { ok: true, task: null }.
//
// Returns:
//   200 { ok: true, task: { id, agent_name, task_subject, task_brief, priority,
//                           venture, depends_on, metadata, started_at } }
//   200 { ok: true, task: null }   (nothing to claim)
//   401 on bad auth
//
// Owner: Atlas (SV-ENG-AGENT-QUEUE / 2026-06-17)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const VALID_AGENTS = new Set([
  'cole','atlas','carter','sage','pierce',
  'hadley','quinn','sterling','ridge','any',
]);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
}

function checkAuth(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return false;
  const tok = h.slice('Bearer '.length).trim();
  return !!CRON_SECRET && tok === CRON_SECRET;
}

async function pickReadyTask(supabase, agent) {
  // Read from the agent_queue_ready VIEW which already encapsulates
  // dependency satisfaction. Highest priority (lowest number), then oldest.
  let q = supabase
    .from('agent_queue_ready')
    .select('id, agent_name, task_subject, task_brief, priority, venture, depends_on, metadata, created_at')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1);

  if (agent === 'any') {
    // Restrict to agents whose state is idle. Two-query approach — simpler
    // than building a join in PostgREST.
    const { data: idleAgents } = await supabase
      .from('agent_state')
      .select('agent_name')
      .eq('status', 'idle');
    const idleList = (idleAgents || []).map((r) => r.agent_name);
    if (idleList.length === 0) return null;
    q = q.in('agent_name', idleList);
  } else {
    q = q.eq('agent_name', agent);
  }

  const { data, error } = await q;
  if (error) throw new Error(`pickReadyTask failed: ${error.message}`);
  if (!data || data.length === 0) return null;
  return data[0];
}

async function claimTask(supabase, task, sessionId) {
  const now = new Date().toISOString();

  // Atomic-ish claim: update only if still pending. Concurrent claimers race
  // here and the loser gets { count: 0 }.
  const meta = { ...(task.metadata || {}), _claim_session: sessionId, _claim_ts: now };
  const { data: claimed, error: claimErr } = await supabase
    .from('agent_queue')
    .update({ status: 'in_progress', started_at: now, metadata: meta })
    .eq('id', task.id)
    .eq('status', 'pending')           // <-- the lock
    .select('id, agent_name, task_subject, task_brief, priority, venture, depends_on, metadata, started_at')
    .single();

  if (claimErr || !claimed) {
    return null; // lost the race or no row
  }

  // Mark the agent busy. We don't fail the claim if this update has trouble —
  // the queue row is the source of truth.
  await supabase
    .from('agent_state')
    .update({
      status: 'working',
      current_task_id: claimed.id,
      last_active_at: now,
      last_heartbeat_at: now,
    })
    .eq('agent_name', claimed.agent_name);

  return claimed;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase env not configured' });
  }
  if (!checkAuth(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const agent = String(body.agent || 'any').toLowerCase().trim();
  if (!VALID_AGENTS.has(agent)) {
    return res.status(400).json({ ok: false, error: `invalid agent. must be one of: ${[...VALID_AGENTS].join(', ')}` });
  }

  const sessionId = String(body.session_id || `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

  // Explicit task_id claim path (Atlas, 2026-07-07 SV-CLAUDE-CODE-CLI-WORKER).
  // Lets the claude-code-worker request a SPECIFIC row after peek-filtering
  // by metadata.task_type instead of taking whatever the highest-priority
  // agent-scoped ready row happens to be (which could belong to the sister
  // agent-queue-poller flow). Additive — normal usage unchanged.
  const taskIdRaw = body.task_id ? String(body.task_id).trim() : null;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (taskIdRaw) {
      // Load the row to confirm it's still pending + agent matches (or agent==='any')
      const { data: row, error: loadErr } = await supabase
        .from('agent_queue')
        .select('id, agent_name, task_subject, task_brief, priority, venture, depends_on, metadata, status, created_at')
        .eq('id', taskIdRaw)
        .single();
      if (loadErr || !row) {
        return res.status(404).json({ ok: true, task: null, note: 'task_id not found' });
      }
      if (row.status !== 'pending') {
        return res.status(200).json({ ok: true, task: null, note: `task already ${row.status}` });
      }
      if (agent !== 'any' && row.agent_name !== agent) {
        return res.status(200).json({ ok: true, task: null, note: `agent mismatch: row=${row.agent_name}` });
      }
      const claimed = await claimTask(supabase, row, sessionId);
      if (claimed) {
        return res.status(200).json({ ok: true, task: claimed, session_id: sessionId });
      }
      return res.status(200).json({ ok: true, task: null, note: 'claim race (row moved between load and update)' });
    }

    // We try up to 3 times in case of claim race. In practice with one poller
    // this never loops, but the cron-tick can hit 9 agents in a burst.
    for (let attempt = 0; attempt < 3; attempt++) {
      const ready = await pickReadyTask(supabase, agent);
      if (!ready) return res.status(200).json({ ok: true, task: null });

      const claimed = await claimTask(supabase, ready, sessionId);
      if (claimed) {
        return res.status(200).json({ ok: true, task: claimed, session_id: sessionId });
      }
      // lost race — pick again
    }
    return res.status(200).json({ ok: true, task: null, note: 'claim race exhausted' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
