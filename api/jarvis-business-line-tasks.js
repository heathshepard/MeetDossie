// Vercel Serverless Function: /api/jarvis-business-line-tasks
// ============================================================================
// Initial-load snapshot for the BUSINESS LINES panel in jarvis-pwa.html.
// Returns agent_queue rows bucketed by business_line, then by status group
// (running / queued / recently_completed). The panel keeps this snapshot
// live afterward off the EXISTING agent_queue_stream Realtime channel — this
// endpoint only needs to answer the "what's the state right now" question on
// first paint / reconnect.
//
// GET /api/jarvis-business-line-tasks?completed_window_hours=24&completed_limit=20
//
// Auth: Bearer Supabase JWT.
//
// Returns:
//   200 {
//     ok: true,
//     business_lines: {
//       dossie:            { running: [...], queued: [...], recently_completed: [...] },
//       sawyer:            { ... },
//       brokerage:         { ... },
//       trading:           { ... },
//       'shepard-ventures':{ ... }   // also catches NULL/uncategorized rows
//     }
//   }
//
// Owner: Atlas, 2026-08-10 (SV-ENG-JARVIS-TASK-VIZ)

import { verifySupabaseToken } from './_middleware/auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const config = { api: { bodyParser: true }, maxDuration: 10 };

const BUSINESS_LINES = ['dossie', 'sawyer', 'brokerage', 'trading', 'shepard-ventures'];

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
    const b = await res.text().catch(() => '');
    throw new Error(`sbGet ${path} -> ${res.status} ${b.slice(0, 200)}`);
  }
  return res.json();
}

function emptyBucket() {
  return { running: [], queued: [], recently_completed: [] };
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  try {
    await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: err.message });
  }

  const q = req.query || {};
  const windowHours = Math.max(1, Math.min(168, parseInt(q.completed_window_hours, 10) || 24));
  const completedLimit = Math.max(1, Math.min(100, parseInt(q.completed_limit, 10) || 20));
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();

  const cols = 'id,agent_name,task_subject,task_brief,priority,status,business_line,venture,created_at,started_at,completed_at,result_summary';

  try {
    const [running, queued, recent] = await Promise.all([
      sbGet(`agent_queue?select=${cols}&status=eq.in_progress&order=started_at.desc.nullslast&limit=200`),
      sbGet(`agent_queue?select=${cols}&status=eq.pending&order=priority.asc,created_at.asc&limit=200`),
      sbGet(`agent_queue?select=${cols}&status=eq.completed&completed_at=gte.${encodeURIComponent(since)}&order=completed_at.desc&limit=500`),
    ]);

    const businessLines = {};
    BUSINESS_LINES.forEach((bl) => { businessLines[bl] = emptyBucket(); });

    const bucketFor = (row) => {
      const bl = row.business_line && BUSINESS_LINES.includes(row.business_line)
        ? row.business_line
        : 'shepard-ventures';
      return businessLines[bl];
    };

    running.forEach((row) => bucketFor(row).running.push(row));
    queued.forEach((row) => bucketFor(row).queued.push(row));
    recent.forEach((row) => bucketFor(row).recently_completed.push(row));

    // Cap recently_completed per business line so the panel can't grow unbounded.
    BUSINESS_LINES.forEach((bl) => {
      businessLines[bl].recently_completed = businessLines[bl].recently_completed.slice(0, completedLimit);
    });

    return res.status(200).json({ ok: true, business_lines: businessLines });
  } catch (err) {
    console.error('[jarvis-business-line-tasks] failed:', err.message);
    return res.status(500).json({ ok: false, error: 'query_failed', detail: err.message });
  }
}
