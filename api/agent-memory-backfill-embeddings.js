// Vercel Serverless Function: POST /api/agent-memory-backfill-embeddings
// ============================================================================
// Backfills NULL embeddings on agent_role_memory rows. Idempotent.
//
// Body (all optional):
//   { role?: "atlas" | ..., batch_size?: 50 }
//
// Auth: Bearer Supabase JWT. Falls back to heath tenant otherwise.
// Owner: atlas_2, 2026-06-22.
// ============================================================================

import { verifySupabaseToken } from './_middleware/auth.js';
import {
  VALID_AGENT_ROLES,
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  sbGet, sbPatch,
  embedText, toPgVectorLiteral,
  resolveTenantIdForAuthUser,
  applyCors,
} from './_lib/agent-memory.js';

export const config = { api: { bodyParser: true }, maxDuration: 60 };

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
  const role = body.role && VALID_AGENT_ROLES.has(body.role) ? body.role : null;
  const batchSize = Math.min(100, Math.max(1, parseInt(body.batch_size, 10) || 50));

  const tenantId = await resolveTenant(req);
  if (!tenantId) return res.status(403).json({ ok: false, error: 'no_tenant' });

  // Fetch rows that need embedding
  const filter = [
    `tenant_id=eq.${tenantId}`,
    `embedding=is.null`,
    role ? `agent_role=eq.${role}` : '',
    `limit=${batchSize}`,
  ].filter(Boolean).join('&');

  let rows;
  try {
    rows = await sbGet(`agent_role_memory?select=id,title,content,agent_role&${filter}`);
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'fetch_failed', detail: err.message });
  }

  if (!rows.length) return res.status(200).json({ ok: true, embedded: 0, message: 'no_pending_rows' });

  let ok = 0, fail = 0;
  const errors = [];
  for (const row of rows) {
    try {
      const text = `${row.title}\n\n${row.content}`;
      const vec = await embedText(text);
      await sbPatch(`agent_role_memory?id=eq.${row.id}`, {
        embedding: toPgVectorLiteral(vec),
      });
      ok++;
    } catch (err) {
      fail++;
      errors.push({ id: row.id, error: err.message.slice(0, 200) });
      // If quota / rate limit, bail early — no point burning the rest
      if (/429|quota|rate/.test(err.message)) {
        return res.status(200).json({
          ok: true, embedded: ok, failed: fail, errors,
          message: 'aborted_on_rate_limit',
        });
      }
    }
  }

  return res.status(200).json({ ok: true, embedded: ok, failed: fail, errors });
}
