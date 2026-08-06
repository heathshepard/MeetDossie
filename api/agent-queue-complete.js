// Vercel Serverless Function: /api/agent-queue-complete
//
// POST — finish an in-flight task. Thin HTTP wrapper around
// api/_lib/agent-queue-complete-core.js, which also handles the
// pending_audit routing (worker completion -> pending_audit -> Quinn
// verdict -> completed | pending w/ 3-retry cap -> blocked+escalate) and
// work-stealing (atomically claims the caller's next ready task before
// returning, so a busy worker never round-trips through a second claim
// call). Full state-machine writeup lives in the core module's header.
//
// cron-agent-queue-dispatch.js calls the SAME core function in-process
// (no self-HTTP-call) so its own completions get identical audit routing.
//
// Auth: Bearer ${CRON_SECRET}
//
// Body:
//   {
//     id: "uuid",
//     status: "completed" | "blocked" | "cancelled" | "pending",
//     result_summary: "string, short",
//     completed_by_agent_session?: "string",
//     metadata?: { ... }                     // merged into existing metadata
//   }
//
// Returns:
//   200 { ok: true, task, next_pending_for_agent: N, stolen_next: {...} | null }
//   404 if id not found
//
// Owner: Atlas (SV-ENG-AGENT-QUEUE / 2026-06-17, audit-loop + work-stealing 2026-08-06)

const { createClient } = require('@supabase/supabase-js');
const { completeTask } = require('./_lib/agent-queue-complete-core.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

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

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const result = await completeTask(supabase, body);

  return res.status(result.status || (result.ok ? 200 : 500)).json(result.ok ? {
    ok: true,
    task: result.task,
    next_pending_for_agent: result.next_pending_for_agent,
    stolen_next: result.stolen_next,
  } : { ok: false, error: result.error });
};
