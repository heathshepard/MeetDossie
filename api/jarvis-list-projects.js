// Vercel Serverless Function: /api/jarvis-list-projects
// ============================================================================
// Returns projects grouped by status. Powers the PROJECTS LEDGER panel.
//
// GET /api/jarvis-list-projects?shipped_window_days=30
//
// Auth: Bearer Supabase JWT.
//
// Returns:
//   200 {
//     ok: true,
//     building: [ { project, instances: [{instance, checklist_summary}], progress_pct } ],
//     recent_shipped: [ { project, instances: [] } ],
//     all: [ { project } ]
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
  return {
    total: mine.length,
    completed: mine.filter(i => i.status === 'completed').length,
    failed: mine.filter(i => i.status === 'failed').length,
    in_progress: mine.filter(i => i.status === 'in_progress').length,
    pending: mine.filter(i => i.status === 'pending').length,
  };
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
  const shippedDays = Math.max(1, Math.min(365, parseInt(q.shipped_window_days, 10) || 30));
  const sinceShipped = new Date(Date.now() - shippedDays * 86400 * 1000).toISOString();
  const allLimit = Math.max(1, Math.min(500, parseInt(q.all_limit, 10) || 200));

  try {
    const [building, recentShipped, all] = await Promise.all([
      sbGet(
        `jarvis_projects?select=*&tenant_id=eq.${tenantId}&status=in.(planning,building)&order=spawned_at.desc&limit=100`
      ),
      sbGet(
        `jarvis_projects?select=*&tenant_id=eq.${tenantId}&status=eq.shipped&completed_at=gte.${encodeURIComponent(sinceShipped)}&order=completed_at.desc&limit=100`
      ),
      sbGet(
        `jarvis_projects?select=*&tenant_id=eq.${tenantId}&order=spawned_at.desc&limit=${allLimit}`
      ),
    ]);

    // Gather all building project IDs + their instances
    const buildingIds = building.map(p => p.id);
    let buildingInstances = [];
    let checklistItems = [];

    if (buildingIds.length > 0) {
      buildingInstances = await sbGet(
        `jarvis_agent_instances?select=*&project_id=in.(${buildingIds.join(',')})&tenant_id=eq.${tenantId}&order=spawned_at.desc&limit=500`
      );
      const instIds = buildingInstances.map(i => i.id);
      if (instIds.length > 0) {
        checklistItems = await sbGet(
          `jarvis_agent_checklist?select=id,instance_id,status&instance_id=in.(${instIds.join(',')})&tenant_id=eq.${tenantId}&limit=5000`
        );
      }
    }

    const buildingAssembled = building.map(p => {
      const projInstances = buildingInstances
        .filter(i => i.project_id === p.id)
        .map(inst => ({
          instance: inst,
          checklist_summary: summarizeChecklist(checklistItems, inst.id),
        }));
      // overall progress = sum(completed) / sum(total) across all instances for this project
      const totalItems = projInstances.reduce((s, x) => s + x.checklist_summary.total, 0);
      const doneItems  = projInstances.reduce((s, x) => s + x.checklist_summary.completed, 0);
      const progressPct = totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 0;
      return {
        project: p,
        instances: projInstances,
        progress_pct: progressPct,
        total_items: totalItems,
        completed_items: doneItems,
      };
    });

    const recentShippedAssembled = recentShipped.map(p => ({ project: p, instances: [] }));

    return res.status(200).json({
      ok: true,
      building: buildingAssembled,
      recent_shipped: recentShippedAssembled,
      all: all.map(p => ({ project: p })),
    });
  } catch (err) {
    console.error('[list-projects] failed:', err.message);
    return res.status(500).json({ ok: false, error: 'list_failed', detail: err.message });
  }
}
