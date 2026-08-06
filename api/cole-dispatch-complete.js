'use strict';

// api/cole-dispatch-complete.js
// =============================================================================
// Completion call for api/cole-dispatch-start.js. Thin wrapper around the
// shared completeTask() core (same one agent-queue-complete.js and
// cron-agent-queue-dispatch.js use), called with steal:false — a live
// interactive session isn't a queue worker polling for its next task, so
// there's nothing to steal.
//
// Because cole-dispatch-start.js sets metadata.skip_audit=true at creation,
// completeTask() routes a 'completed' status straight to 'completed' instead
// of 'pending_audit' — see api/_lib/agent-queue-complete-core.js.
//
// POST /api/cole-dispatch-complete
// Headers: Authorization: Bearer ${CRON_SECRET}
// Body:
//   {
//     id: "uuid" (required — the id returned by cole-dispatch-start),
//     status: "completed" | "blocked" | "cancelled" (default "completed"),
//     result_summary: string (required, short),
//   }
//
// Response 200:
//   { ok: true, id, status, completed_at, result_summary }
// 404 if id not found. 400 if id/result_summary missing or status invalid.
//
// OWNER: Atlas, 2026-08-06 (SV-ENG-AGENT-QUEUE-LIVE-DISPATCH, part 2 of the
// live per-agent Jarvis panel work).

const { createClient } = require('@supabase/supabase-js');
const { completeTask } = require('./_lib/agent-queue-complete-core.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const ACCEPTED_STATUS = new Set(['completed', 'blocked', 'cancelled']);

function checkAuth(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return false;
  return !!CRON_SECRET && h.slice('Bearer '.length).trim() === CRON_SECRET;
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
  if (!checkAuth(req)) {
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

  const id = String(body.id || '').trim();
  const status = String(body.status || 'completed').toLowerCase().trim();
  const resultSummary = String(body.result_summary || '').trim();

  if (!id) return res.status(400).json({ ok: false, error: 'id_required' });
  if (!resultSummary) return res.status(400).json({ ok: false, error: 'result_summary_required' });
  if (!ACCEPTED_STATUS.has(status)) {
    return res.status(400).json({ ok: false, error: `status must be one of: ${[...ACCEPTED_STATUS].join(', ')}` });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const result = await completeTask(supabase, {
    id,
    status,
    result_summary: resultSummary,
    completed_by_agent_session: 'cole-live-dispatch',
    steal: false,
  });

  if (!result.ok) {
    return res.status(result.status || 500).json({ ok: false, error: result.error });
  }

  return res.status(200).json({
    ok: true,
    id: result.task.id,
    status: result.task.status,
    completed_at: result.task.completed_at,
    result_summary: result.task.result_summary,
  });
};
