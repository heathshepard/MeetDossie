// api/jarvis-activity-log.js
// ============================================================================
// GET /api/jarvis-activity-log?limit=50&window_hours=48
//
// Returns the ACTIVITY LOG panel payload for the Jarvis HUD.
//
// Source: agent_queue (the authoritative live-agent activity table).
// Prior sources jarvis_agent_events and agent_task_queue are DEAD
// (last writes 2026-06-22 / 2026-06-26) — the 12-day-stale panel bug
// on 2026-07-01 was caused by the frontend reading jarvis_agent_events
// directly. This endpoint fixes it by reading agent_queue.
//
// Response shape matches the frontend renderer (renderActivityLog):
//   { ok, events: [{ agent_name, task_title, status, event_type,
//                    result_summary, created_at, started_at,
//                    completed_at, id }] }
//
// Auth: Bearer Supabase JWT, tenant resolved server-side.
// Owner: Atlas, 2026-07-01 HUD freshness sweep.
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

// agent_queue rows are not tenant-scoped in the current schema (single-tenant
// operator use). We simply return the most-recent N across the whole queue.
export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  try {
    // Auth is required so the panel only renders for signed-in Heath.
    await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: err.message });
  }

  const q = req.query || {};
  const limit = Math.max(1, Math.min(200, parseInt(q.limit, 10) || 50));
  const windowHours = Math.max(1, Math.min(24 * 30, parseInt(q.window_hours, 10) || 48));
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();

  try {
    // Order by whichever timestamp is newest — completed > started > created.
    // PostgREST can't COALESCE across columns in an order clause, so we pull
    // by created_at desc within the window (queue rows are typically written
    // once at enqueue) and let the client sort if needed.
    const rows = await sbGet(
      `agent_queue?select=id,agent_name,task_subject,task_brief,status,result_summary,created_at,started_at,completed_at&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=${limit}`
    );

    // Map agent_queue.status -> the frontend's expected status vocabulary.
    // renderActivityLog understands: 'completed', 'failed', 'working' (default).
    const statusMap = (s) => {
      const v = (s || '').toLowerCase();
      if (v === 'completed' || v === 'done')        return 'completed';
      if (v === 'failed' || v === 'error')          return 'failed';
      if (v === 'in_progress' || v === 'working' ||
          v === 'started' || v === 'running')       return 'working';
      if (v === 'queued' || v === 'pending')        return 'working';
      return v || 'working';
    };
    const eventTypeMap = (s) => {
      const v = (s || '').toLowerCase();
      if (v === 'completed' || v === 'done')   return 'completed';
      if (v === 'failed' || v === 'error')     return 'failed';
      if (v === 'in_progress' || v === 'working' ||
          v === 'started'    || v === 'running') return 'progress';
      if (v === 'queued' || v === 'pending')   return 'spawned';
      return 'progress';
    };

    const events = rows.map((r) => ({
      id:             r.id,
      agent_name:     r.agent_name || '?',
      task_title:     r.task_subject || '(no title)',
      summary:        r.task_brief || null,
      result_summary: r.result_summary || null,
      status:         statusMap(r.status),
      event_type:     eventTypeMap(r.status),
      started_at:     r.started_at,
      completed_at:   r.completed_at,
      // created_at is what the frontend uses for fmtAgo — but a completed
      // task's "when" is really completed_at. Surface both.
      created_at:     r.completed_at || r.started_at || r.created_at,
      _created_at:    r.created_at,
    }));

    return res.status(200).json({
      ok: true,
      events,
      window_hours: windowHours,
      source: 'agent_queue',
    });
  } catch (err) {
    console.error('[jarvis-activity-log] failed:', err.message);
    return res.status(500).json({ ok: false, error: 'activity_log_failed', detail: err.message });
  }
}
