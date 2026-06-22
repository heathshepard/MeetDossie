// Vercel Serverless Function: GET /api/agent-memory-load
// ============================================================================
// Returns the top N relevant prior learnings for an agent role, scored by
// semantic similarity x recency x heath-approval x usage_count.
//
// Query params (GET) or JSON body (POST):
//   role:           "atlas" | ... | "jarvis"             [required]
//   context:        free-form text describing the new spawn / task / utterance [required]
//   limit:          1..50 (default 20)
//   threshold:      cosine similarity floor 0..1 (default 0.40)
//   bump_usage:     "1" | "true" to increment usage_count on returned rows
//   format:         "json" (default) | "system_prompt" (returns string ready to inject)
//
// Auth: optional. Same tenant resolution as /api/agent-memory-learn.
//
// Owner: atlas_2, 2026-06-22.
// ============================================================================

import { verifySupabaseToken } from './_middleware/auth.js';
import {
  VALID_AGENT_ROLES,
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  sbGet, sbPatch,
  embedText, searchMemory,
  resolveTenantIdForAuthUser,
  applyCors,
  formatLessonsAsSystemBlock,
} from './_lib/agent-memory.js';

export const config = { api: { bodyParser: true }, maxDuration: 15 };

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

  // Accept both GET (query string) and POST (json body)
  const input = req.method === 'POST'
    ? (req.body || {})
    : (req.query || {});

  const role = String(input.role || '').trim().toLowerCase();
  const context = String(input.context || '').trim();
  const limit = Math.min(50, Math.max(1, parseInt(input.limit, 10) || 20));
  const threshold = (() => {
    const n = parseFloat(input.threshold);
    if (!Number.isFinite(n)) return 0.40;
    return Math.min(0.95, Math.max(0.05, n));
  })();
  const bumpUsage = input.bump_usage === '1' || input.bump_usage === 'true' || input.bump_usage === true;
  const format = (input.format === 'system_prompt') ? 'system_prompt' : 'json';

  if (!role || !VALID_AGENT_ROLES.has(role)) {
    return res.status(400).json({ ok: false, error: 'invalid_role', valid: Array.from(VALID_AGENT_ROLES) });
  }
  if (!context || context.length < 4) {
    return res.status(400).json({ ok: false, error: 'context_required' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  const tenantId = await resolveTenant(req);
  if (!tenantId) return res.status(403).json({ ok: false, error: 'no_tenant' });

  // Embed the context
  let embedding;
  try {
    embedding = await embedText(context);
  } catch (err) {
    console.error('[agent-memory-load] embed failed:', err.message);
    return res.status(502).json({ ok: false, error: 'embed_failed', detail: err.message });
  }

  // Search
  let lessons;
  try {
    lessons = await searchMemory(tenantId, role, embedding, {
      matchThreshold: threshold,
      matchCount: limit,
    });
  } catch (err) {
    console.error('[agent-memory-load] search failed:', err.message);
    return res.status(500).json({ ok: false, error: 'search_failed', detail: err.message });
  }

  // Optional usage_count bump (only when returned lessons are actually being injected)
  if (bumpUsage && lessons.length > 0) {
    // Fire-and-forget; failure here shouldn't block the caller.
    (async () => {
      try {
        for (const m of lessons) {
          await sbPatch(`agent_role_memory?id=eq.${m.id}`, {
            usage_count: (m.usage_count || 0) + 1,
            last_used_at: new Date().toISOString(),
          });
        }
      } catch (e) {
        console.warn('[agent-memory-load] bump_usage non-fatal:', e.message);
      }
    })();
  }

  if (format === 'system_prompt') {
    const block = formatLessonsAsSystemBlock(role, lessons);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(block);
  }

  return res.status(200).json({
    ok: true,
    role,
    count: lessons.length,
    lessons,
  });
}
