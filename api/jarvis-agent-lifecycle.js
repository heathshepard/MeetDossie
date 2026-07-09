// api/jarvis-agent-lifecycle.js
// ============================================================================
// POST /api/jarvis-agent-lifecycle
//
// Server-to-server write endpoint for the active_agents ledger consumed by
// GET /api/jarvis-active-agents (Carter's read-side, Layer 2 CEO cockpit).
//
// Body shape:
//   {
//     action: 'spawned' | 'notification' | 'completed' | 'failed',
//     agent_id: string (required, UNIQUE),  // e.g. "atlas_1" | "carter_2"
//     agent_name?: string,                  // required on spawned
//     task_description?: string,            // required on spawned
//     parent_prompt_summary?: string,       // optional on spawned
//     last_notification?: string,           // required on notification
//     result_summary?: string               // optional on completed/failed
//   }
//
// Auth: Bearer CRON_SECRET   OR   Bearer SUPABASE_SERVICE_ROLE_KEY.
// This is orchestrator-facing (Jarvis / Cole spawn hooks); no customer flow.
//
// Returns:
//   200 { ok: true, id: <uuid>, action: <action> }
//   400 on validation
//   401 on auth failure
//   500 on DB error
//
// Owner: Atlas (Layer 2 CEO cockpit write-side), 2026-07-09.
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const VALID_ACTIONS = new Set(['spawned', 'notification', 'completed', 'failed']);

export const config = { api: { bodyParser: true }, maxDuration: 10 };

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function extractBearer(req) {
  const h = (req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function authorize(req) {
  const token = extractBearer(req);
  if (!token) return { ok: false, reason: 'missing_bearer' };
  if (CRON_SECRET && token === CRON_SECRET) return { ok: true, via: 'cron_secret' };
  if (SUPABASE_SERVICE_ROLE_KEY && token === SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: true, via: 'service_role' };
  }
  return { ok: false, reason: 'invalid_bearer' };
}

async function sbPatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`sbPatch ${path} -> ${res.status} ${t.slice(0, 300)}`);
  }
  return res.json();
}

async function sbUpsert(path, body, onConflict) {
  const url = onConflict
    ? `${SUPABASE_URL}/rest/v1/${path}?on_conflict=${onConflict}`
    : `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: onConflict
        ? 'return=representation,resolution=merge-duplicates'
        : 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`sbUpsert ${path} -> ${res.status} ${t.slice(0, 300)}`);
  }
  return res.json();
}

function truncate(s, n) {
  if (s == null) return null;
  const str = String(s);
  return str.length > n ? str.slice(0, n) : str;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  const auth = authorize(req);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: auth.reason });
  }

  const body = req.body || {};
  const { action, agent_id } = body;

  if (!action || !VALID_ACTIONS.has(action)) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_action',
      valid: Array.from(VALID_ACTIONS),
    });
  }
  if (!agent_id || typeof agent_id !== 'string') {
    return res.status(400).json({ ok: false, error: 'missing_agent_id' });
  }

  const nowIso = new Date().toISOString();

  try {
    // ---------- SPAWNED (upsert; agent_id is UNIQUE) ----------
    if (action === 'spawned') {
      const { agent_name, task_description, parent_prompt_summary } = body;
      if (!agent_name) return res.status(400).json({ ok: false, error: 'missing_agent_name' });
      if (!task_description) {
        return res.status(400).json({ ok: false, error: 'missing_task_description' });
      }

      const row = {
        agent_id: truncate(agent_id, 120),
        agent_name: truncate(agent_name, 120),
        task_description: truncate(task_description, 1000),
        parent_prompt_summary: truncate(parent_prompt_summary, 2000),
        spawned_at: nowIso,
        updated_at: nowIso,
        status: 'running',
        completed_at: null,
        result_summary: null,
      };
      const inserted = await sbUpsert('active_agents', row, 'agent_id');
      const record = Array.isArray(inserted) ? inserted[0] : inserted;
      return res.status(200).json({ ok: true, id: record?.id, action, via: auth.via });
    }

    // ---------- NOTIFICATION (update in place) ----------
    if (action === 'notification') {
      const { last_notification } = body;
      if (!last_notification) {
        return res.status(400).json({ ok: false, error: 'missing_last_notification' });
      }
      const patch = {
        last_notification: truncate(last_notification, 1000),
        last_notification_at: nowIso,
        updated_at: nowIso,
      };
      const updated = await sbPatch(
        `active_agents?agent_id=eq.${encodeURIComponent(agent_id)}`,
        patch
      );
      if (!Array.isArray(updated) || updated.length === 0) {
        return res.status(404).json({ ok: false, error: 'agent_id_not_found', agent_id });
      }
      return res.status(200).json({ ok: true, id: updated[0].id, action, via: auth.via });
    }

    // ---------- COMPLETED ----------
    if (action === 'completed') {
      const { result_summary } = body;
      const patch = {
        status: 'completed',
        completed_at: nowIso,
        updated_at: nowIso,
        result_summary: truncate(result_summary, 2000),
      };
      const updated = await sbPatch(
        `active_agents?agent_id=eq.${encodeURIComponent(agent_id)}`,
        patch
      );
      if (!Array.isArray(updated) || updated.length === 0) {
        return res.status(404).json({ ok: false, error: 'agent_id_not_found', agent_id });
      }
      return res.status(200).json({ ok: true, id: updated[0].id, action, via: auth.via });
    }

    // ---------- FAILED ----------
    if (action === 'failed') {
      const { result_summary } = body;
      const patch = {
        status: 'failed',
        completed_at: nowIso,
        updated_at: nowIso,
        result_summary: truncate(result_summary || 'Failed (no detail supplied).', 2000),
      };
      const updated = await sbPatch(
        `active_agents?agent_id=eq.${encodeURIComponent(agent_id)}`,
        patch
      );
      if (!Array.isArray(updated) || updated.length === 0) {
        return res.status(404).json({ ok: false, error: 'agent_id_not_found', agent_id });
      }
      return res.status(200).json({ ok: true, id: updated[0].id, action, via: auth.via });
    }

    // Unreachable
    return res.status(400).json({ ok: false, error: 'unhandled_action' });
  } catch (err) {
    console.error('[jarvis-agent-lifecycle] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
