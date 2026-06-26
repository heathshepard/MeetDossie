'use strict';

// api/cole-write-context.js
// =============================================================================
// Cole/Jarvis project-context writer. Upserts a row into jarvis_project_context
// so when Cole writes a new memory file in ~/.claude/projects/, the parallel
// row exists in Supabase and the next voice turn from Jarvis can see it.
//
// POST /api/cole-write-context
// Headers: Authorization: Bearer ${CRON_SECRET}
// Body:
//   {
//     key: string                — slug-cased identifier (required, unique per tenant)
//     title: string              — human title (required)
//     summary: string            — 1-3 sentence speakable summary (required)
//     status: 'active' | 'paused' | 'blocked' | 'shipped' | 'archived' (default 'active')
//     priority: 1-5              — 1 = top of federation, 5 = backlog (default 3)
//     source_memory_path: string — relative path under .claude/projects/ (optional)
//     tags: string[]             — e.g. ['marketing','paused','pierce'] (optional)
//     expires_at: ISO timestamp  — null = evergreen (optional)
//   }
//
// Response:
//   { ok: true, id, key, action: 'inserted' | 'updated' }
//
// Owner: Atlas, 2026-06-26 (atlas_12 — Jarvis Project Context federation).

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;

// Heath's tenants.id (multitenant pattern). Same value used in cole-enqueue's
// downstream resolution. Cole always writes context for Heath's tenant.
const HEATH_TENANT_ID = 'a9a4c3aa-7278-4f42-ad71-e2e899671fab';

const VALID_STATUSES = new Set(['active', 'paused', 'blocked', 'shipped', 'archived']);

async function sb(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => { buf += chunk; });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function slugify(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }

  // Validate inputs
  const rawKey   = String(body.key || '').trim();
  const key      = slugify(rawKey);
  const title    = String(body.title || '').trim();
  const summary  = String(body.summary || '').trim();
  const status   = String(body.status || 'active').toLowerCase().trim();
  const priority = Number.isFinite(body.priority) ? Math.max(1, Math.min(5, Math.floor(body.priority))) : 3;
  const sourceMemoryPath = body.source_memory_path
    ? String(body.source_memory_path).slice(0, 500)
    : null;
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t) => typeof t === 'string' && t.length > 0 && t.length < 64).slice(0, 16)
    : [];
  const expiresAt = body.expires_at && typeof body.expires_at === 'string'
    ? body.expires_at
    : null;

  if (!key) return res.status(400).json({ ok: false, error: 'key_required' });
  if (!title) return res.status(400).json({ ok: false, error: 'title_required' });
  if (!summary) return res.status(400).json({ ok: false, error: 'summary_required' });
  if (!VALID_STATUSES.has(status)) {
    return res.status(400).json({ ok: false, error: `invalid_status:${status}` });
  }
  if (summary.length > 2000) {
    return res.status(400).json({ ok: false, error: 'summary_too_long_max_2000' });
  }
  if (expiresAt) {
    const d = Date.parse(expiresAt);
    if (Number.isNaN(d)) {
      return res.status(400).json({ ok: false, error: 'expires_at_invalid_iso' });
    }
  }

  // Upsert via PostgREST. on_conflict=tenant_id,key + Prefer:resolution=merge-duplicates
  // means an existing row with the same (tenant_id, key) is UPDATED, otherwise INSERTED.
  const payload = {
    tenant_id: HEATH_TENANT_ID,
    key,
    title: title.slice(0, 280),
    summary: summary.slice(0, 2000),
    status,
    priority,
    tags,
    source_memory_path: sourceMemoryPath,
    expires_at: expiresAt,
    last_updated_at: new Date().toISOString(),
  };

  // First: check if a row already exists so we can report inserted vs updated.
  const existing = await sb(
    `jarvis_project_context?select=id&tenant_id=eq.${HEATH_TENANT_ID}&key=eq.${encodeURIComponent(key)}&limit=1`
  );
  const wasExisting = existing.ok && Array.isArray(existing.data) && existing.data.length > 0;
  const existingId = wasExisting ? existing.data[0].id : null;

  const upsert = await sb('jarvis_project_context?on_conflict=tenant_id,key', {
    method: 'POST',
    headers: {
      Prefer: 'return=representation,resolution=merge-duplicates',
    },
    body: JSON.stringify(payload),
  });

  if (!upsert.ok || !Array.isArray(upsert.data) || !upsert.data[0]) {
    return res.status(500).json({
      ok: false,
      error: `upsert_failed:${upsert.status}`,
      detail: upsert.data,
    });
  }

  const row = upsert.data[0];
  return res.status(200).json({
    ok: true,
    id: row.id,
    key: row.key,
    title: row.title,
    status: row.status,
    priority: row.priority,
    action: wasExisting ? 'updated' : 'inserted',
    previous_id: existingId,
  });
};
