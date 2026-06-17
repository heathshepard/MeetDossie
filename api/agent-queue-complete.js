// Vercel Serverless Function: /api/agent-queue-complete
//
// POST — finish an in-flight task. Sets terminal state on the agent_queue row
// and flips agent_state back to idle so the picker can hand them the next one
// without delay.
//
// Auth: Bearer ${CRON_SECRET}
//
// Body:
//   {
//     id: "uuid",                            // the agent_queue.id being closed
//     status: "completed" | "blocked" | "cancelled",
//     result_summary: "string, short",       // 1-3 sentence summary
//     completed_by_agent_session?: "string",
//     metadata?: { ... }                     // merged into existing metadata
//   }
//
// Returns:
//   200 { ok: true, task, next_pending_for_agent: N }
//   404 if id not found
//
// Owner: Atlas (SV-ENG-AGENT-QUEUE / 2026-06-17)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const TERMINAL = new Set(['completed', 'blocked', 'cancelled']);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
}

function checkAuth(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return false;
  return !!CRON_SECRET && h.slice('Bearer '.length).trim() === CRON_SECRET;
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

  const id = String(body.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });

  const status = String(body.status || 'completed').toLowerCase().trim();
  if (!TERMINAL.has(status)) {
    return res.status(400).json({ ok: false, error: `status must be one of: ${[...TERMINAL].join(', ')}` });
  }

  const result_summary = String(body.result_summary || '').slice(0, 4000);
  const completed_by_agent_session = body.completed_by_agent_session
    ? String(body.completed_by_agent_session).slice(0, 200)
    : null;
  const extraMeta = (body.metadata && typeof body.metadata === 'object') ? body.metadata : {};

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Load the row first so we can merge metadata and surface agent_name for the
  // state update afterward.
  const { data: existing, error: loadErr } = await supabase
    .from('agent_queue')
    .select('id, agent_name, status, metadata')
    .eq('id', id)
    .single();

  if (loadErr || !existing) {
    return res.status(404).json({ ok: false, error: 'task not found' });
  }

  const merged = { ...(existing.metadata || {}), ...extraMeta };

  const now = new Date().toISOString();
  const { data: updated, error: updErr } = await supabase
    .from('agent_queue')
    .update({
      status,
      completed_at: now,
      completed_by_agent_session,
      result_summary,
      metadata: merged,
    })
    .eq('id', id)
    .select('id, agent_name, task_subject, status, completed_at, result_summary')
    .single();

  if (updErr) return res.status(500).json({ ok: false, error: updErr.message });

  // Flip agent back to idle (unless they've already been re-claimed for the
  // next task in a tight loop — in which case current_task_id will already
  // be different and we shouldn't reset it). We only update if current_task
  // is still pointing at this task.
  await supabase
    .from('agent_state')
    .update({
      status: 'idle',
      current_task_id: null,
      last_active_at: now,
      last_heartbeat_at: now,
    })
    .eq('agent_name', existing.agent_name)
    .eq('current_task_id', existing.id);

  // Count remaining pending tasks for this agent so the caller can decide
  // whether to immediately claim another.
  const { count: nextPending } = await supabase
    .from('agent_queue')
    .select('id', { count: 'exact', head: true })
    .eq('agent_name', existing.agent_name)
    .eq('status', 'pending');

  return res.status(200).json({
    ok: true,
    task: updated,
    next_pending_for_agent: nextPending || 0,
  });
};
