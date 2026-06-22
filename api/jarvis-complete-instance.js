// Vercel Serverless Function: /api/jarvis-complete-instance
// ============================================================================
// Called by an agent instance when its work is done. Updates the instance row
// (status + completed_at + final evidence_summary). Optionally bumps the
// owning project to `shipped` if `mark_project_shipped: true`.
//
// POST /api/jarvis-complete-instance
//   Body:
//     {
//       instance_id: uuid,                   // jarvis_agent_instances.id (NOT the denormalized "atlas_3")
//       final_status: "completed" | "failed" | "cancelled",
//       evidence_summary?: string,
//       gold_tag?: string,
//       mark_project_shipped?: boolean       // bumps project.status -> 'shipped'
//     }
//
// Auth: Bearer Supabase JWT.
//
// Returns:
//   200 { ok: true, instance: {...}, project?: {...} }
//   400 invalid input
//   401 / 403 / 404 / 500 errors
//
// Owner: Atlas (atlas_1, 2026-06-22 SOP build).

import { verifySupabaseToken } from './_middleware/auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VALID_FINAL = new Set(['completed', 'failed', 'cancelled']);

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
    const b = await res.text().catch(() => '');
    throw new Error(`sbGet ${path} -> ${res.status} ${b.slice(0, 200)}`);
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
    const b = await res.text().catch(() => '');
    throw new Error(`sbPatch ${path} -> ${res.status} ${b.slice(0, 200)}`);
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
  const { instance_id, final_status, evidence_summary, gold_tag, mark_project_shipped } = body;

  if (!instance_id || typeof instance_id !== 'string') {
    return res.status(400).json({ ok: false, error: 'instance_id_required' });
  }
  if (!final_status || !VALID_FINAL.has(final_status)) {
    return res.status(400).json({
      ok: false, error: 'invalid_final_status', valid: Array.from(VALID_FINAL),
    });
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

  // Confirm instance belongs to caller's tenant
  let instance;
  try {
    const rows = await sbGet(
      `jarvis_agent_instances?select=*&id=eq.${instance_id}&tenant_id=eq.${tenantId}&limit=1`
    );
    if (!rows || rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'instance_not_found_or_not_yours' });
    }
    instance = rows[0];
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'lookup_failed', detail: err.message });
  }

  const now = new Date().toISOString();
  const instancePatch = {
    status: final_status,
    completed_at: instance.completed_at || now,
  };

  let updatedInstance;
  try {
    const updated = await sbPatch(
      `jarvis_agent_instances?id=eq.${instance_id}&tenant_id=eq.${tenantId}`,
      instancePatch
    );
    updatedInstance = updated[0] || instance;
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'instance_update_failed', detail: err.message });
  }

  // Update project if attached + caller asked OR an evidence_summary/gold_tag was passed
  let updatedProject = null;
  if (instance.project_id && (mark_project_shipped || evidence_summary || gold_tag)) {
    const projPatch = {};
    if (mark_project_shipped) {
      projPatch.status = 'shipped';
      projPatch.completed_at = now;
    }
    if (evidence_summary) projPatch.evidence_summary = String(evidence_summary);
    if (gold_tag) projPatch.gold_tag = String(gold_tag).slice(0, 200);
    try {
      const updated = await sbPatch(
        `jarvis_projects?id=eq.${instance.project_id}&tenant_id=eq.${tenantId}`,
        projPatch
      );
      updatedProject = updated[0] || null;
    } catch (err) {
      console.warn('[complete-instance] project update failed:', err.message);
    }
  }

  return res.status(200).json({
    ok: true,
    instance: updatedInstance,
    project: updatedProject,
  });
}
