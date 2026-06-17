// Vercel Serverless Function: /api/agent-queue-peek
//
// GET — read-only view of the highest-priority ready tasks, with metadata.
//
// Used by the local poller (scripts/agent-queue-poller.js) when AUTONOMOUS_ONLY
// mode is on. The poller calls peek first to decide WHICH agent's task to
// claim — that way claim only ever locks a task we actually intend to run.
//
// This avoids needing direct Supabase access on Heath's laptop (production
// env doesn't necessarily expose SUPABASE_URL / service role key the way the
// API does).
//
// Auth: Bearer ${CRON_SECRET}
//
// Query params:
//   ?limit=N            (default 20, max 50)
//   ?autonomous_only=1  (filter to metadata->>'autonomous' = 'true' OR
//                        metadata->>'is_smoke_test' = 'true')
//
// Returns:
//   200 { ok: true, tasks: [{id, agent_name, task_subject, priority, venture, metadata}] }
//   401 on bad auth
//
// Owner: Atlas (SV-ENG-AGENT-QUEUE / 2026-06-17)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
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
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase env not configured' });
  }
  if (!checkAuth(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  let limit = parseInt(req.query.limit || '20', 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  if (limit > 50) limit = 50;

  const autonomousOnly = String(req.query.autonomous_only || '').toLowerCase() === '1'
    || String(req.query.autonomous_only || '').toLowerCase() === 'true';

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Use the ready view so dependency satisfaction is already enforced.
  let q = supabase
    .from('agent_queue_ready')
    .select('id, agent_name, task_subject, priority, venture, metadata, created_at')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(limit);

  const { data, error } = await q;
  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  let tasks = data || [];
  if (autonomousOnly) {
    tasks = tasks.filter((row) => {
      const m = row.metadata || {};
      return m.autonomous === true || m.is_smoke_test === true;
    });
  }

  return res.status(200).json({ ok: true, tasks, count: tasks.length });
};
