// Vercel Serverless Function: /api/jarvis-update-checklist-item
// ============================================================================
// Idempotent update to a jarvis_agent_checklist row. Called by an agent
// instance as it works through its checklist.
//
// POST /api/jarvis-update-checklist-item
//   Body:
//     {
//       item_id: uuid,                          // required
//       status?: "pending"|"in_progress"|"completed"|"failed",
//       evidence_files?: string[],
//       commit_sha?: string,
//       screenshot_paths?: string[],
//       apv_status?: "not_run"|"pass"|"fail",
//       failure_reason?: string,
//       notes?: string
//     }
//
// Auth: Bearer Supabase JWT. RLS ensures the item belongs to caller's tenant.
//
// Side-effects:
//   - status='in_progress' -> sets started_at if null
//   - status='completed' or 'failed' -> sets completed_at if null
//
// Returns:
//   200 { ok: true, item: {...} }
//   400 invalid input
//   401 / 403 / 404 / 500 errors
//
// Owner: Atlas (atlas_1, 2026-06-22 SOP build).

import { verifySupabaseToken } from './_middleware/auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VALID_STATUS = new Set(['pending', 'in_progress', 'completed', 'failed']);
const VALID_APV    = new Set(['not_run', 'pass', 'fail']);

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
    item_id,
    status,
    evidence_files,
    commit_sha,
    screenshot_paths,
    apv_status,
    failure_reason,
    notes,
  } = body;

  if (!item_id || typeof item_id !== 'string') {
    return res.status(400).json({ ok: false, error: 'item_id_required' });
  }
  if (status != null && !VALID_STATUS.has(status)) {
    return res.status(400).json({ ok: false, error: 'invalid_status', valid: Array.from(VALID_STATUS) });
  }
  if (apv_status != null && !VALID_APV.has(apv_status)) {
    return res.status(400).json({ ok: false, error: 'invalid_apv_status', valid: Array.from(VALID_APV) });
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

  // Verify item belongs to caller's tenant (we use service role to bypass RLS;
  // enforce manually here).
  let existing;
  try {
    const rows = await sbGet(
      `jarvis_agent_checklist?select=*&id=eq.${item_id}&tenant_id=eq.${tenantId}&limit=1`
    );
    if (!rows || rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'item_not_found_or_not_yours' });
    }
    existing = rows[0];
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'lookup_failed', detail: err.message });
  }

  // Build patch payload
  const patch = {};
  if (status != null) patch.status = status;
  if (Array.isArray(evidence_files)) patch.evidence_files = evidence_files;
  if (commit_sha != null) patch.commit_sha = String(commit_sha).slice(0, 64);
  if (Array.isArray(screenshot_paths)) patch.screenshot_paths = screenshot_paths;
  if (apv_status != null) patch.apv_status = apv_status;
  if (failure_reason != null) patch.failure_reason = String(failure_reason);
  if (notes != null) patch.notes = String(notes);

  // Lifecycle timestamps
  const now = new Date().toISOString();
  if (status === 'in_progress' && !existing.started_at) {
    patch.started_at = now;
  }
  if ((status === 'completed' || status === 'failed') && !existing.completed_at) {
    patch.completed_at = now;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(200).json({ ok: true, item: existing, note: 'no_changes' });
  }

  try {
    const updated = await sbPatch(
      `jarvis_agent_checklist?id=eq.${item_id}&tenant_id=eq.${tenantId}`,
      patch
    );
    return res.status(200).json({ ok: true, item: updated[0] });
  } catch (err) {
    console.error('[update-checklist-item] patch failed:', err.message);
    return res.status(500).json({ ok: false, error: 'patch_failed', detail: err.message });
  }
}
