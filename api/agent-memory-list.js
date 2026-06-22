// Vercel Serverless Function: GET /api/agent-memory-list
// ============================================================================
// Returns counts per agent_role + (optionally) all lessons for one role.
// Used by the AGENT KNOWLEDGE widget on the Projects Ledger panel.
//
// Query params:
//   role?:        if set, returns full lesson list for that role
//   include_archived?: "1" to include archived (default false)
//   limit?:       1..200 (default 50; only when role set)
//
// Returns:
//   { ok: true, counts: { atlas: 12, hadley: 5, ... }, lessons?: [...] }
//
// Auth: optional. Falls back to heath tenant.
// Owner: atlas_2, 2026-06-22.
// ============================================================================

import { verifySupabaseToken } from './_middleware/auth.js';
import {
  VALID_AGENT_ROLES,
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  sbGet,
  resolveTenantIdForAuthUser,
  applyCors,
} from './_lib/agent-memory.js';

export const config = { api: { bodyParser: true }, maxDuration: 10 };

async function resolveTenant(req) {
  try {
    const user = await verifySupabaseToken(req);
    if (user && user.userId) {
      const t = await resolveTenantIdForAuthUser(user.userId);
      if (t) return t;
    }
  } catch (_) {}
  const headerTenant = (req.headers['x-jarvis-tenant-id'] || '').toString().trim();
  if (headerTenant) return headerTenant;
  try {
    const rows = await sbGet(`tenants?select=id&slug=eq.heath&limit=1`);
    if (rows && rows[0]) return rows[0].id;
  } catch (_) {}
  return null;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  const q = req.query || {};
  const role = q.role && VALID_AGENT_ROLES.has(q.role) ? q.role : null;
  const includeArchived = q.include_archived === '1' || q.include_archived === 'true';
  const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 50));

  const tenantId = await resolveTenant(req);
  if (!tenantId) return res.status(403).json({ ok: false, error: 'no_tenant' });

  try {
    // Always return counts
    const archiveFilter = includeArchived ? '' : '&validation_status=neq.archived';
    const all = await sbGet(`agent_role_memory?select=agent_role&tenant_id=eq.${tenantId}${archiveFilter}`);
    const counts = {};
    for (const r of all) counts[r.agent_role] = (counts[r.agent_role] || 0) + 1;
    const total = all.length;

    let lessons = null;
    if (role) {
      const order = 'order=usage_count.desc,learned_at.desc';
      const path = `agent_role_memory?select=id,title,content,category,validation_status,usage_count,tags,learned_at,last_used_at&tenant_id=eq.${tenantId}&agent_role=eq.${role}${archiveFilter}&${order}&limit=${limit}`;
      lessons = await sbGet(path);
    }

    return res.status(200).json({
      ok: true,
      total,
      counts,
      role,
      lessons,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'list_failed', detail: err.message });
  }
}
