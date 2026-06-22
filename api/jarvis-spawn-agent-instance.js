// Vercel Serverless Function: /api/jarvis-spawn-agent-instance
// ============================================================================
// Creates a new jarvis_agent_instances row + (optionally) a jarvis_projects row
// + the initial jarvis_agent_checklist items the instance must complete.
//
// SOP locked 2026-06-22: every agent spawn mints a unique instance_id
// (atlas_1, atlas_2, hadley_1, ...). One project per instance. Parallel work
// = clone (spawn atlas_2 alongside atlas_1).
//
// POST /api/jarvis-spawn-agent-instance
//   Body:
//     {
//       agent_role: "atlas" | "carter" | "hadley" | "pierce" | "sage"
//                 | "ridge" | "quinn" | "sterling" | "jarvis",
//       project_id?: uuid,             // attach to existing project
//       project_title?: string,        // OR create a new project on the fly
//       project_description?: string,  // (optional)
//       spawn_prompt?: string,         // what Jarvis told the agent
//       checklist_items?: [
//         { title: string, display_order?: int }
//       ]
//     }
//
// Auth: Bearer Supabase JWT, tenant resolved server-side from jarvis_users.
//
// Returns:
//   200 { ok: true, instance: { id, instance_id, ... }, project: {...}, checklist: [...] }
//   400 invalid input
//   401 / 403 / 500 errors
//
// Owner: Atlas (atlas_1, 2026-06-22 SOP build).

import { verifySupabaseToken } from './_middleware/auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VALID_AGENT_ROLES = new Set([
  'atlas', 'carter', 'hadley', 'pierce', 'sage',
  'ridge', 'quinn', 'sterling', 'jarvis',
]);

export const config = { api: { bodyParser: true }, maxDuration: 10 };

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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
    const body = await res.text().catch(() => '');
    throw new Error(`sbGet ${path} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function sbPost(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`sbPost ${path} -> ${res.status} ${errBody.slice(0, 200)}`);
  }
  return res.json();
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
    const errBody = await res.text().catch(() => '');
    throw new Error(`sbPatch ${path} -> ${res.status} ${errBody.slice(0, 200)}`);
  }
  return res.json();
}

async function resolveTenantId(authUserId) {
  const rows = await sbGet(
    `jarvis_users?select=tenant_id&auth_user_id=eq.${authUserId}&limit=1`
  );
  if (!rows || rows.length === 0) return null;
  return rows[0].tenant_id;
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

  let authUser;
  try {
    authUser = await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: err.message });
  }

  const body = req.body || {};
  const {
    agent_role,
    project_id: incomingProjectId,
    project_title,
    project_description,
    spawn_prompt,
    checklist_items,
  } = body;

  if (!agent_role || !VALID_AGENT_ROLES.has(agent_role)) {
    return res.status(400).json({
      ok: false, error: 'invalid_agent_role',
      valid: Array.from(VALID_AGENT_ROLES),
    });
  }

  let tenantId;
  try {
    tenantId = await resolveTenantId(authUser.userId);
  } catch (err) {
    console.error('[spawn-agent-instance] tenant resolve:', err.message);
    return res.status(500).json({ ok: false, error: 'tenant_lookup_failed' });
  }
  if (!tenantId) {
    return res.status(403).json({ ok: false, error: 'no_jarvis_tenant' });
  }

  // Resolve or create the project
  let project = null;
  try {
    if (incomingProjectId) {
      const existing = await sbGet(
        `jarvis_projects?select=*&id=eq.${incomingProjectId}&tenant_id=eq.${tenantId}&limit=1`
      );
      if (!existing || existing.length === 0) {
        return res.status(404).json({ ok: false, error: 'project_not_found' });
      }
      project = existing[0];
    } else if (project_title) {
      const created = await sbPost('jarvis_projects', {
        tenant_id: tenantId,
        title: String(project_title).slice(0, 200),
        description: project_description ? String(project_description) : null,
        status: 'building',
      });
      project = created[0];
    }
  } catch (err) {
    console.error('[spawn-agent-instance] project step:', err.message);
    return res.status(500).json({ ok: false, error: 'project_failed', detail: err.message });
  }

  // Create the instance — instance_number + instance_id auto-assigned by trigger
  let instance;
  try {
    // instance_number/instance_id are required NOT NULL with default placeholders;
    // the BEFORE INSERT trigger overrides them. Send 0 + empty string sentinel.
    const inserted = await sbPost('jarvis_agent_instances', {
      tenant_id: tenantId,
      agent_role,
      instance_number: 0,
      instance_id: '',
      project_id: project ? project.id : null,
      status: 'running',
      spawn_prompt: spawn_prompt ? String(spawn_prompt) : null,
    });
    instance = inserted[0];
  } catch (err) {
    console.error('[spawn-agent-instance] instance insert:', err.message);
    return res.status(500).json({ ok: false, error: 'instance_insert_failed', detail: err.message });
  }

  // If we just created a project and there's no owning_agent_instance_id, set it
  if (project && !project.owning_agent_instance_id) {
    try {
      const updated = await sbPatch(
        `jarvis_projects?id=eq.${project.id}`,
        { owning_agent_instance_id: instance.id }
      );
      project = updated[0] || project;
    } catch (err) {
      // non-fatal; just log
      console.warn('[spawn-agent-instance] owning_agent_instance_id set failed:', err.message);
    }
  }

  // Seed checklist items if provided
  let checklist = [];
  if (Array.isArray(checklist_items) && checklist_items.length > 0) {
    try {
      const rows = checklist_items.map((item, idx) => ({
        tenant_id: tenantId,
        instance_id: instance.id,
        display_order: Number.isInteger(item.display_order) ? item.display_order : (idx + 1),
        title: String(item.title || '(untitled item)').slice(0, 500),
        status: 'pending',
      }));
      checklist = await sbPost('jarvis_agent_checklist', rows);
    } catch (err) {
      console.error('[spawn-agent-instance] checklist insert:', err.message);
      // We still return the instance — checklist insert failure shouldn't roll back the spawn.
      checklist = [];
    }
  }

  return res.status(200).json({
    ok: true,
    instance,
    project,
    checklist,
  });
}
