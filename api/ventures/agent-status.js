/**
 * POST /api/ventures/agent-status
 *
 * HOW AGENTS USE THIS ENDPOINT:
 * -----------------------------------------------------------------------
 * To appear as "working" (pulsing coral dot) in the Shepard Ventures dashboard:
 *
 *   POST /api/ventures/agent-status
 *   Authorization: Bearer <CRON_SECRET>
 *   Content-Type: application/json
 *   { "agent_name": "carter", "status": "working", "task_description": "Building agent-status endpoint" }
 *
 * To go back to idle (static dot) when done:
 *
 *   POST /api/ventures/agent-status
 *   Authorization: Bearer <CRON_SECRET>
 *   { "agent_name": "carter", "status": "idle", "task_description": "" }
 *
 * Valid status values: "working" | "idle"
 * The dashboard polls every 15 seconds. A last_ping older than 5 minutes
 * automatically falls back to the heartbeat-based status in overview.js.
 * -----------------------------------------------------------------------
 *
 * Auth: Bearer CRON_SECRET (same token used by all cron endpoints)
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET  = process.env.CRON_SECRET;

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;
const LOCAL_RE   = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin) || PREVIEW_RE.test(origin) || LOCAL_RE.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
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

const VALID_AGENTS = new Set([
  'atlas', 'carter', 'cole', 'content_verifier', 'hadley', 'pierce', 'sage',
]);
const VALID_STATUSES = new Set(['working', 'idle']);

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth: Bearer CRON_SECRET
  const authHeader = req.headers.authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { agent_name, status, task_description = '' } = req.body || {};

  if (!agent_name || !VALID_AGENTS.has(agent_name)) {
    return res.status(400).json({ error: `Invalid agent_name. Must be one of: ${[...VALID_AGENTS].join(', ')}` });
  }
  if (!status || !VALID_STATUSES.has(status)) {
    return res.status(400).json({ error: 'Invalid status. Must be "working" or "idle".' });
  }

  const now = new Date().toISOString();

  // Upsert into ventures_agents: update status, last_ping, task_description
  const upsertRes = await supa(
    `ventures_agents?agent_name=eq.${encodeURIComponent(agent_name)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        status,
        last_ping: now,
        last_active_at: now,
        task_description: task_description || null,
        updated_at: now,
      }),
    }
  );

  if (!upsertRes.ok) {
    const errText = await upsertRes.text();
    console.error('[agent-status] upsert failed:', upsertRes.status, errText);
    return res.status(500).json({ error: 'Failed to update agent status', detail: errText });
  }

  // Write to ventures_activity_events so the activity feed updates
  if (status === 'working' && task_description) {
    const eventRes = await supa('ventures_activity_events', {
      method: 'POST',
      body: JSON.stringify({
        agent_name,
        company: 'dossie',
        event_type: 'task_started',
        summary: task_description,
        detail: { status: 'working' },
      }),
    });
    if (!eventRes.ok) {
      // Non-fatal — log and continue
      console.warn('[agent-status] activity event insert failed:', await eventRes.text());
    }
  }

  return res.status(200).json({ ok: true, agent_name, status, updated_at: now });
}
