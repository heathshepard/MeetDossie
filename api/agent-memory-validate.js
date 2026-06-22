// Vercel Serverless Function: POST /api/agent-memory-validate
// ============================================================================
// Heath (or an instance running self-review) marks a lesson as:
//   heath_approved | contested | archived | auto (revert to default)
//
// Body:
//   {
//     memory_id: uuid,
//     status:    "heath_approved" | "contested" | "archived" | "auto",
//     note?:     string (appended to content as a "// 2026-06-22 Heath: ..." line)
//   }
//
// Auth: Bearer Supabase JWT (Heath's session). If not present, falls back
// to the service-role-default heath tenant for internal automation.
//
// Owner: atlas_2, 2026-06-22.
// ============================================================================

import { verifySupabaseToken } from './_middleware/auth.js';
import {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  sbGet, sbPatch,
  resolveTenantIdForAuthUser,
  applyCors,
} from './_lib/agent-memory.js';

export const config = { api: { bodyParser: true }, maxDuration: 10 };

const VALID = new Set(['heath_approved', 'contested', 'archived', 'auto']);

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
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  const body = req.body || {};
  const memoryId = String(body.memory_id || '').trim();
  const status = String(body.status || '').trim();
  const note = body.note ? String(body.note).slice(0, 500) : null;

  if (!memoryId) return res.status(400).json({ ok: false, error: 'memory_id_required' });
  if (!VALID.has(status)) {
    return res.status(400).json({ ok: false, error: 'invalid_status', valid: Array.from(VALID) });
  }

  const tenantId = await resolveTenant(req);
  if (!tenantId) return res.status(403).json({ ok: false, error: 'no_tenant' });

  // Verify the memory belongs to this tenant
  let existing;
  try {
    const rows = await sbGet(`agent_role_memory?select=id,content,validation_status&id=eq.${memoryId}&tenant_id=eq.${tenantId}&limit=1`);
    if (!rows || rows.length === 0) return res.status(404).json({ ok: false, error: 'memory_not_found' });
    existing = rows[0];
  } catch (err) {
    console.error('[agent-memory-validate] lookup failed:', err.message);
    return res.status(500).json({ ok: false, error: 'lookup_failed' });
  }

  const patch = { validation_status: status };
  if (note) {
    const dateStr = new Date().toISOString().slice(0, 10);
    const stamp = `\n\n// ${dateStr} Heath: ${note}`;
    patch.content = (existing.content + stamp).slice(0, 4000);
  }

  try {
    const updated = await sbPatch(`agent_role_memory?id=eq.${memoryId}`, patch);
    return res.status(200).json({ ok: true, memory: updated && updated[0] });
  } catch (err) {
    console.error('[agent-memory-validate] update failed:', err.message);
    return res.status(500).json({ ok: false, error: 'update_failed', detail: err.message });
  }
}
