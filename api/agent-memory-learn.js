// Vercel Serverless Function: POST /api/agent-memory-learn
// ============================================================================
// An agent instance contributes a new lesson into the shared role-scoped pool.
//
// Body:
//   {
//     role:        "atlas" | "carter" | ... | "jarvis",
//     title:       string (<= 200 chars),
//     content:     string (1-4000 chars — the lesson body),
//     category?:   "api_gotcha" | "workflow" | "code_pattern" | "external_service_quirk"
//                 | "heath_preference" | "customer_pattern" | "legal_nuance"
//                 | "security" | "cost_optimization" | "voice_ux",
//     instance_id?:        uuid (jarvis_agent_instances.id of the learner),
//     tags?:               string[]   (e.g. ["elevenlabs","429"]),
//     embedding_text?:     string     (text used for embedding — defaults to title + content),
//     validation_status?:  "auto" | "heath_approved" | "contested" | "archived" (default "auto"),
//     dedupe_threshold?:   number     (cosine similarity threshold for dedupe, default 0.92)
//   }
//
// Behavior:
//   1. Embed the text via OpenAI text-embedding-3-small (1536 dim).
//   2. Query agent_memory_find_duplicate(); if a duplicate exists, increment
//      usage_count + append instance_id to source_instance_ids. Return 200
//      with action="merged".
//   3. Otherwise insert a new row. Return 200 with action="inserted".
//
// Auth: optional. If a Bearer Supabase JWT is provided, tenant is resolved
// from jarvis_users; otherwise tenant is resolved from the heath tenant
// (single-tenant fallback for service-side seeding).
//
// Owner: atlas_2, 2026-06-22.
// ============================================================================

import { verifySupabaseToken } from './_middleware/auth.js';
import {
  VALID_AGENT_ROLES, VALID_CATEGORIES,
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  sbGet, sbPost,
  embedText, toPgVectorLiteral,
  findDuplicate, incrementUsage,
  resolveTenantIdForAuthUser,
  applyCors,
} from './_lib/agent-memory.js';

export const config = { api: { bodyParser: true }, maxDuration: 15 };

async function resolveTenant(req) {
  try {
    const user = await verifySupabaseToken(req);
    if (user && user.userId) {
      const t = await resolveTenantIdForAuthUser(user.userId);
      if (t) return t;
    }
  } catch (_) {
    // unauthenticated — allow service-side fallback below
  }
  // Service-side fallback (for cron / seed / internal helpers running with
  // SERVICE_ROLE creds). We require X-Jarvis-Tenant-Id header in that case.
  const headerTenant = (req.headers['x-jarvis-tenant-id'] || req.headers['X-Jarvis-Tenant-Id'] || '').toString().trim();
  if (headerTenant) return headerTenant;
  // Last resort: default heath tenant (single-tenant prod today)
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
  const role = String(body.role || '').trim().toLowerCase();
  const title = String(body.title || '').trim().slice(0, 200);
  const content = String(body.content || '').trim().slice(0, 4000);
  const category = (body.category && VALID_CATEGORIES.has(body.category)) ? body.category : 'workflow';
  const tags = Array.isArray(body.tags) ? body.tags.filter(t => typeof t === 'string').slice(0, 16) : [];
  const instanceId = body.instance_id || null;
  const validationStatus = body.validation_status && ['auto','heath_approved','contested','archived'].includes(body.validation_status)
    ? body.validation_status : 'auto';
  const dedupeThreshold = typeof body.dedupe_threshold === 'number'
    ? Math.min(0.99, Math.max(0.7, body.dedupe_threshold))
    : 0.92;

  if (!role || !VALID_AGENT_ROLES.has(role)) {
    return res.status(400).json({ ok: false, error: 'invalid_role', valid: Array.from(VALID_AGENT_ROLES) });
  }
  if (!title || title.length < 4) {
    return res.status(400).json({ ok: false, error: 'invalid_title_too_short' });
  }
  if (!content || content.length < 20) {
    return res.status(400).json({ ok: false, error: 'invalid_content_too_short' });
  }

  const tenantId = await resolveTenant(req);
  if (!tenantId) {
    return res.status(403).json({ ok: false, error: 'no_tenant' });
  }

  const embedSource = (body.embedding_text && typeof body.embedding_text === 'string')
    ? body.embedding_text
    : `${title}\n\n${content}`;

  // 1. Embed
  let embedding;
  try {
    embedding = await embedText(embedSource);
  } catch (err) {
    console.error('[agent-memory-learn] embed failed:', err.message);
    return res.status(502).json({ ok: false, error: 'embed_failed', detail: err.message });
  }

  // 2. Dedupe check
  let duplicate;
  try {
    duplicate = await findDuplicate(tenantId, role, embedding, dedupeThreshold);
  } catch (err) {
    console.error('[agent-memory-learn] dedupe check failed:', err.message);
    // continue without dedupe rather than failing
    duplicate = null;
  }

  if (duplicate) {
    try {
      const merged = await incrementUsage(duplicate.id, instanceId);
      return res.status(200).json({
        ok: true,
        action: 'merged',
        memory_id: duplicate.id,
        similarity: duplicate.similarity,
        usage_count: merged && merged.usage_count,
        message: 'Similar lesson already exists — incremented usage_count.',
      });
    } catch (err) {
      console.error('[agent-memory-learn] incrementUsage failed:', err.message);
      return res.status(500).json({ ok: false, error: 'increment_usage_failed', detail: err.message });
    }
  }

  // 3. Insert new lesson
  try {
    const row = {
      tenant_id: tenantId,
      agent_role: role,
      title,
      content,
      category,
      learned_by_instance_id: instanceId,
      validation_status: validationStatus,
      source_instance_ids: instanceId ? [instanceId] : [],
      embedding: toPgVectorLiteral(embedding),
      tags,
      usage_count: 0,
    };
    const inserted = await sbPost('agent_role_memory', row);
    return res.status(200).json({
      ok: true,
      action: 'inserted',
      memory: inserted && inserted[0],
    });
  } catch (err) {
    console.error('[agent-memory-learn] insert failed:', err.message);
    return res.status(500).json({ ok: false, error: 'insert_failed', detail: err.message });
  }
}
