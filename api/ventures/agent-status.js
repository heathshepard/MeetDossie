/**
 * GET  /api/ventures/agent-status  — list all agents with current status
 * POST /api/ventures/agent-status  — upsert agent status (self-reporting by agents)
 *
 * HOW AGENTS SELF-REPORT (copy this snippet to any agent task file):
 * -----------------------------------------------------------------------
 * // --- ATLAS AGENT STATUS REPORTING ---
 * // Call at task start:
 * //   await reportStatus('carter', 'active', 'Building fill-form PDF endpoint', '2026-05-29T14:00:00Z');
 * // Send heartbeat every ~2 min while working:
 * //   await reportStatus('carter', 'active', 'Building fill-form PDF endpoint');
 * // Call on completion:
 * //   await reportStatus('carter', 'completed', 'Fill-form endpoint shipped');
 * // Call if blocked:
 * //   await reportStatus('carter', 'blocked', 'Waiting for TREC PDF base64 asset');
 *
 * async function reportStatus(agentName, status, taskDescription, estimatedCompletionAt) {
 *   try {
 *     await fetch('https://meetdossie.com/api/ventures/agent-status', {
 *       method: 'POST',
 *       headers: {
 *         'Authorization': `Bearer ${process.env.CRON_SECRET}`,
 *         'Content-Type': 'application/json',
 *       },
 *       body: JSON.stringify({ agent_name: agentName, status, task_description: taskDescription, estimated_completion_at: estimatedCompletionAt }),
 *     });
 *   } catch (e) { console.warn('[agent-status] self-report failed:', e.message); }
 * }
 * -----------------------------------------------------------------------
 *
 * Valid status values: "active" | "idle" | "completed" | "blocked"
 * - "active"    = currently executing a task (coral pulse dot)
 * - "idle"      = available, no current task (gray dot)
 * - "completed" = just finished a task (sage dot, auto-fades to idle after 10 min)
 * - "blocked"   = waiting on input or dependency (gold dot)
 *
 * The dashboard agent activity panel polls GET every 30 seconds.
 * A last_heartbeat older than 10 minutes auto-downgrades to "idle" in GET response.
 *
 * Auth: GET uses Supabase JWT (same as overview.js). POST uses Bearer CRON_SECRET.
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET  = process.env.CRON_SECRET;

const AUTHORIZED_EMAILS = new Set(['heath.shepard@kw.com', 'heath@meetdossie.com', 'heath.shepard@gmail.com']);

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;
const LOCAL_RE   = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req, res, methods = 'GET,POST,OPTIONS') {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin) || PREVIEW_RE.test(origin) || LOCAL_RE.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
}

function supa(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  return fetch(url, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      ...(opts.headers || {}),
    },
  });
}

// Canonical agent roster — add new agents here
const AGENT_ROSTER = [
  { key: 'cole',             display: 'Cole',             role: 'Chief of Staff'  },
  { key: 'hadley',           display: 'Hadley',           role: 'General Counsel' },
  { key: 'pierce',           display: 'Pierce',           role: 'Growth + CS'     },
  { key: 'atlas',            display: 'Atlas',            role: 'Platform Eng'    },
  { key: 'carter',           display: 'Carter',           role: 'Product Eng'     },
  { key: 'sage',             display: 'Sage',             role: 'Social Media'    },
  { key: 'content_verifier', display: 'Verifier',         role: 'Fact Check'      },
];
const VALID_AGENTS   = new Set(AGENT_ROSTER.map(a => a.key));
const VALID_STATUSES = new Set(['active', 'idle', 'completed', 'blocked', 'working']); // 'working' is legacy alias for 'active'

// How long without a heartbeat before we auto-downgrade to idle
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();

  // -----------------------------------------------------------------------
  // GET — list all agents (auth: Supabase JWT)
  // -----------------------------------------------------------------------
  if (req.method === 'GET') {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized - no token' });
    }
    const token = authHeader.slice(7);

    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Unauthorized - invalid token' });
    const userData = await userRes.json();
    if (!AUTHORIZED_EMAILS.has(userData.email)) {
      return res.status(403).json({ error: 'Forbidden - admin only' });
    }

    // Fetch current state from ventures_agents.
    // Try the full column set first; fall back to baseline columns if new ones don't exist yet.
    // Migration SQL to unlock full functionality (run once in Supabase SQL editor):
    // ALTER TABLE ventures_agents ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
    // ALTER TABLE ventures_agents ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
    // ALTER TABLE ventures_agents ADD COLUMN IF NOT EXISTS estimated_completion_at TIMESTAMPTZ;
    // ALTER TABLE ventures_agents ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
    let agentRes = await supa(
      'ventures_agents?select=agent_name,display_name,status,task_description,last_active_at,last_ping,last_heartbeat_at,started_at,estimated_completion_at,completed_at&order=agent_name.asc',
      { headers: { Prefer: 'return=representation' } }
    );
    // If 400 (likely unknown columns), retry with baseline columns only
    if (!agentRes.ok && agentRes.status === 400) {
      agentRes = await supa(
        'ventures_agents?select=agent_name,display_name,status,task_description,last_active_at,last_ping&order=agent_name.asc',
        { headers: { Prefer: 'return=representation' } }
      );
    }

    const nowMs = Date.now();

    let dbRows = [];
    if (agentRes.ok) {
      dbRows = await agentRes.json();
    }

    // Build a map from DB rows
    const dbMap = {};
    for (const row of dbRows) {
      dbMap[row.agent_name] = row;
    }

    // Merge roster defaults with DB state
    const agents = AGENT_ROSTER.map(def => {
      const row = dbMap[def.key] || {};

      // Determine heartbeat time: last_heartbeat_at (new column) → last_ping (existing) → last_active_at
      const heartbeatTs = row.last_heartbeat_at || row.last_ping || row.last_active_at || null;
      const heartbeatMs = heartbeatTs ? new Date(heartbeatTs).getTime() : 0;
      const isStale     = heartbeatMs > 0 && (nowMs - heartbeatMs) > STALE_THRESHOLD_MS;

      // Auto-downgrade: if DB says active/working/completed but heartbeat is stale → idle
      let effectiveStatus = row.status || 'idle';
      if (effectiveStatus === 'working') effectiveStatus = 'active'; // normalize legacy value
      if (isStale && effectiveStatus !== 'idle') effectiveStatus = 'idle';

      // completed auto-fades to idle after 10 min (same stale window)
      if (effectiveStatus === 'completed' && isStale) effectiveStatus = 'idle';

      return {
        name:                 def.key,
        displayName:          row.display_name || def.display,
        role:                 def.role,
        status:               effectiveStatus,
        taskDescription:      effectiveStatus !== 'idle' ? (row.task_description || null) : null,
        startedAt:            row.started_at || null,
        estimatedCompletionAt: row.estimated_completion_at || null,
        completedAt:          row.completed_at || null,
        lastHeartbeatAt:      heartbeatTs,
        lastActiveAt:         row.last_active_at || null,
        isStale,
      };
    });

    return res.status(200).json({ agents, generatedAt: new Date().toISOString() });
  }

  // -----------------------------------------------------------------------
  // POST — agent self-reports status (auth: Bearer CRON_SECRET)
  // -----------------------------------------------------------------------
  if (req.method === 'POST') {
    const authHeader = req.headers.authorization || '';
    if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const {
      agent_name,
      status,
      task_description = '',
      estimated_completion_at = null,
    } = req.body || {};

    if (!agent_name || !VALID_AGENTS.has(agent_name)) {
      return res.status(400).json({ error: `Invalid agent_name. Must be one of: ${[...VALID_AGENTS].join(', ')}` });
    }
    if (!status || !VALID_STATUSES.has(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be one of: active, idle, completed, blocked.' });
    }

    const normalizedStatus = status === 'working' ? 'active' : status; // normalize legacy alias
    const now = new Date().toISOString();

    // Build update payload
    // last_ping is the existing column; last_heartbeat_at is the new alias — both kept in sync
    const patch = {
      status: normalizedStatus,
      last_ping: now,           // existing column (backwards compat)
      last_active_at: now,
      task_description: task_description || null,
      updated_at: now,
    };

    // Track when a new task started
    if (normalizedStatus === 'active') {
      patch.started_at = now;
      patch.completed_at = null;
    }
    if (normalizedStatus === 'completed') {
      patch.completed_at = now;
    }
    if (normalizedStatus === 'idle') {
      patch.task_description = null;
      patch.started_at = null;
      patch.completed_at = null;
      patch.estimated_completion_at = null;
    }
    if (estimated_completion_at) {
      patch.estimated_completion_at = estimated_completion_at;
    }

    const upsertRes = await supa(
      `ventures_agents?agent_name=eq.${encodeURIComponent(agent_name)}`,
      { method: 'PATCH', body: JSON.stringify(patch) }
    );

    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      console.error('[agent-status] PATCH failed:', upsertRes.status, errText);
      return res.status(500).json({ error: 'Failed to update agent status', detail: errText });
    }

    // Write to ventures_activity_events when a task starts (non-fatal)
    if (normalizedStatus === 'active' && task_description) {
      const eventRes = await supa('ventures_activity_events', {
        method: 'POST',
        body: JSON.stringify({
          agent_name,
          company: 'dossie',
          event_type: 'task_started',
          summary: task_description,
          detail: { status: normalizedStatus },
        }),
      });
      if (!eventRes.ok) {
        console.warn('[agent-status] activity event insert failed:', await eventRes.text());
      }
    }
    if (normalizedStatus === 'completed' && task_description) {
      const eventRes = await supa('ventures_activity_events', {
        method: 'POST',
        body: JSON.stringify({
          agent_name,
          company: 'dossie',
          event_type: 'task_completed',
          summary: `Completed: ${task_description}`,
          detail: { status: normalizedStatus },
        }),
      });
      if (!eventRes.ok) {
        console.warn('[agent-status] activity event insert failed:', await eventRes.text());
      }
    }

    return res.status(200).json({ ok: true, agent_name, status: normalizedStatus, updated_at: now });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
