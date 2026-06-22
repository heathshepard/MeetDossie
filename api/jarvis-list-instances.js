// Vercel Serverless Function: /api/jarvis-list-instances
// ============================================================================
// Returns running + recently-completed agent instances for the tenant, along
// with each instance's checklist progress (total / completed / failed counts).
// Powers the AGENT STATUS panel cards in jarvis-pwa.html.
//
// GET /api/jarvis-list-instances?completed_window_hours=24&limit=50
//
// Auth: Bearer Supabase JWT.
//
// Returns:
//   200 {
//     ok: true,
//     running: [ { instance, project, checklist_summary } ],
//     recent:  [ { instance, project, checklist_summary } ]
//   }
//
// Owner: Atlas (atlas_1, 2026-06-22 SOP build).

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
    const b = await res.text().catch(() => '');
    throw new Error(`sbGet ${path} -> ${res.status} ${b.slice(0, 200)}`);
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

function summarizeChecklist(items, instanceId) {
  const mine = items.filter(i => i.instance_id === instanceId);
  const summary = {
    total: mine.length,
    completed: mine.filter(i => i.status === 'completed').length,
    failed: mine.filter(i => i.status === 'failed').length,
    in_progress: mine.filter(i => i.status === 'in_progress').length,
    pending: mine.filter(i => i.status === 'pending').length,
  };
  return summary;
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

  let authUser;
  try {
    authUser = await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: err.message });
  }

  let tenantId;
  try {
    tenantId = await resolveTenantId(authUser.userId);
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'tenant_lookup_failed' });
  }
  if (!tenantId) {
    return res.status(403).json({ ok: false, error: 'no_jarvis_tenant' });
  }

  const q = req.query || {};
  const windowHours = Math.max(1, Math.min(168, parseInt(q.completed_window_hours, 10) || 24));
  const limit = Math.max(1, Math.min(200, parseInt(q.limit, 10) || 50));
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();

  try {
    // Running instances (any age)
    const runningPromise = sbGet(
      `jarvis_agent_instances?select=*&tenant_id=eq.${tenantId}&status=eq.running&order=spawned_at.desc&limit=${limit}`
    );
    // Recently completed/failed/cancelled (within window)
    const recentPromise = sbGet(
      `jarvis_agent_instances?select=*&tenant_id=eq.${tenantId}&status=in.(completed,failed,cancelled)&completed_at=gte.${encodeURIComponent(since)}&order=completed_at.desc&limit=${limit}`
    );
    const [running, recent] = await Promise.all([runningPromise, recentPromise]);

    const instanceIds = [...running, ...recent].map(r => r.id);
    const projectIds = [...new Set([...running, ...recent].map(r => r.project_id).filter(Boolean))];

    let checklistItems = [];
    if (instanceIds.length > 0) {
      const idsCsv = instanceIds.join(',');
      checklistItems = await sbGet(
        `jarvis_agent_checklist?select=id,instance_id,status&instance_id=in.(${idsCsv})&tenant_id=eq.${tenantId}&limit=2000`
      );
    }

    let projectsById = {};
    if (projectIds.length > 0) {
      const projects = await sbGet(
        `jarvis_projects?select=*&id=in.(${projectIds.join(',')})&tenant_id=eq.${tenantId}`
      );
      projects.forEach(p => { projectsById[p.id] = p; });
    }

    const assemble = (inst) => ({
      instance: inst,
      project: inst.project_id ? (projectsById[inst.project_id] || null) : null,
      checklist_summary: summarizeChecklist(checklistItems, inst.id),
    });

    return res.status(200).json({
      ok: true,
      running: running.map(assemble),
      recent:  recent.map(assemble),
    });
  } catch (err) {
    console.error('[list-instances] failed:', err.message);
    return res.status(500).json({ ok: false, error: 'list_failed', detail: err.message });
  }
}
