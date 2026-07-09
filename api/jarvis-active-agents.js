// api/jarvis-active-agents.js
// ============================================================================
// GET /api/jarvis-active-agents
//
// Returns the agent-status panel payload for Jarvis HUD.
// Shows running agents + recently-completed (last 5 min).
//
// Response shape:
//   { ok: true,
//     running: [ { id, agent_name, task_description, spawned_at,
//                   elapsed_seconds, last_notification,
//                   last_notification_at } ],
//     recently_completed: [ ... same fields ... ],
//     agent_count: N
//   }
//
// Auth: Bearer Supabase JWT (service role for live data).
// Owner: Carter (Drafter), 2026-07-09. Jarvis instruments writes.
// ============================================================================

import { verifySupabaseToken } from './_middleware/auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const config = { api: { bodyParser: true }, maxDuration: 10 };

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`sbGet ${path} -> ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  try {
    // Auth is required so panel only renders for signed-in Heath.
    await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: err.message });
  }

  try {
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();

    // Fetch running agents (status='running')
    const runningRows = await sbGet(
      `active_agents?select=id,agent_id,agent_name,task_description,spawned_at,updated_at,last_notification,last_notification_at&status=eq.running&order=spawned_at.desc&limit=50`
    );

    // Fetch recently completed (status != 'running' and completed_at > now-5min)
    const completedRows = await sbGet(
      `active_agents?select=id,agent_id,agent_name,task_description,spawned_at,updated_at,completed_at,last_notification,result_summary&status=neq.running&completed_at=gte.${encodeURIComponent(fiveMinutesAgo)}&order=completed_at.desc&limit=20`
    );

    // Enrich running rows with elapsed_seconds
    const enrichedRunning = runningRows.map((row) => ({
      id: row.id,
      agent_name: row.agent_name,
      task_description: row.task_description || '',
      spawned_at: row.spawned_at,
      elapsed_seconds: Math.floor((now - new Date(row.updated_at)) / 1000),
      last_notification: row.last_notification || '',
      last_notification_at: row.last_notification_at,
    }));

    // Enrich completed rows
    const enrichedCompleted = completedRows.map((row) => ({
      id: row.id,
      agent_name: row.agent_name,
      task_description: row.task_description || '',
      spawned_at: row.spawned_at,
      elapsed_seconds: Math.floor((new Date(row.completed_at) - new Date(row.spawned_at)) / 1000),
      completed_at: row.completed_at,
      result_summary: row.result_summary || '',
      status: 'completed',
    }));

    return res.status(200).json({
      ok: true,
      running: enrichedRunning,
      recently_completed: enrichedCompleted,
      agent_count: enrichedRunning.length,
      updated_at: now.toISOString(),
    });
  } catch (err) {
    console.error('jarvis-active-agents error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}
