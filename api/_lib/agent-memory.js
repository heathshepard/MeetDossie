// api/_lib/agent-memory.js
// ============================================================================
// Shared helpers for the Shared Agent Memory Pool.
//
// Used by:
//   api/agent-memory-learn.js
//   api/agent-memory-load.js
//   api/agent-memory-validate.js
//   api/jarvis-voice.js (loads role memory into the Jarvis system prompt)
//   scripts/spawn-jarvis-agent.js (loads relevant lessons before spawn)
//
// Functions:
//   embedText(text)                 -> Float32Array of length 1536 (OpenAI text-embedding-3-small)
//   findDuplicate(tenantId, role, embedding, threshold) -> { id, similarity, usage_count } | null
//   incrementUsage(memoryId, sourceInstanceId)
//   searchMemory(tenantId, role, embedding, opts) -> rows[]
//   resolveTenantIdForAuthUser(authUserId) -> uuid | null
//
// Locked by atlas_2, 2026-06-22.
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const VALID_AGENT_ROLES = new Set([
  'atlas', 'carter', 'hadley', 'pierce', 'sage',
  'ridge', 'quinn', 'sterling', 'jarvis',
]);

const VALID_CATEGORIES = new Set([
  'api_gotcha', 'workflow', 'code_pattern', 'external_service_quirk',
  'heath_preference', 'customer_pattern', 'legal_nuance', 'security',
  'cost_optimization', 'voice_ux',
]);

async function sbRpc(fnName, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sbRpc ${fnName} -> ${res.status} ${body.slice(0, 250)}`);
  }
  return res.json();
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
    throw new Error(`sbGet ${path} -> ${res.status} ${body.slice(0, 250)}`);
  }
  return res.json();
}

async function sbPost(path, body, prefer = 'return=representation') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`sbPost ${path} -> ${res.status} ${errBody.slice(0, 250)}`);
  }
  if (prefer === 'return=minimal') return null;
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
    throw new Error(`sbPatch ${path} -> ${res.status} ${errBody.slice(0, 250)}`);
  }
  return res.json();
}

// ----------------------------------------------------------------------------
// Embedding via OpenAI text-embedding-3-small (1536 dim, $0.02 / 1M tokens)
// ----------------------------------------------------------------------------
async function embedText(text) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
  const trimmed = String(text || '').slice(0, 8000); // model max ~8k tokens, char-based safe cap
  if (!trimmed) throw new Error('empty embed input');

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: trimmed,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`embed_failed ${res.status} ${body.slice(0, 250)}`);
  }
  const json = await res.json();
  const vec = json && json.data && json.data[0] && json.data[0].embedding;
  if (!Array.isArray(vec) || vec.length !== 1536) {
    throw new Error('embed_invalid_dim');
  }
  return vec;
}

// pgvector accepts the textual form: '[0.12, -0.45, ...]'
function toPgVectorLiteral(arr) {
  return '[' + arr.map(n => Number(n).toFixed(6)).join(',') + ']';
}

// ----------------------------------------------------------------------------
// Dedupe lookup
// ----------------------------------------------------------------------------
async function findDuplicate(tenantId, agentRole, embedding, threshold = 0.92) {
  const rows = await sbRpc('agent_memory_find_duplicate', {
    p_tenant_id: tenantId,
    p_agent_role: agentRole,
    p_query_embed: toPgVectorLiteral(embedding),
    p_threshold: threshold,
  });
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

// ----------------------------------------------------------------------------
// Append instance to source list + increment usage_count
// ----------------------------------------------------------------------------
async function incrementUsage(memoryId, sourceInstanceId) {
  // Use SQL via PostgREST RPC would require a function; do this as a read-modify-write
  // Acceptable for our volume (single-tenant, low write rate).
  const rows = await sbGet(`agent_role_memory?select=source_instance_ids,usage_count&id=eq.${memoryId}&limit=1`);
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  const ids = Array.isArray(row.source_instance_ids) ? row.source_instance_ids : [];
  if (sourceInstanceId && !ids.includes(sourceInstanceId)) ids.push(sourceInstanceId);
  const updated = await sbPatch(`agent_role_memory?id=eq.${memoryId}`, {
    source_instance_ids: ids,
    usage_count: (row.usage_count || 0) + 1,
    last_used_at: new Date().toISOString(),
  });
  return updated && updated[0];
}

async function bumpLastUsed(memoryIds) {
  if (!Array.isArray(memoryIds) || memoryIds.length === 0) return;
  // single PATCH covering many ids
  const inList = memoryIds.map(id => `"${id}"`).join(',');
  try {
    await sbPatch(`agent_role_memory?id=in.(${inList})`, {
      last_used_at: new Date().toISOString(),
      usage_count: undefined, // skip — we can't bump in a single PATCH without RPC
    });
  } catch (_) {
    // non-fatal
  }
}

// ----------------------------------------------------------------------------
// Semantic search (returns top N lessons)
// ----------------------------------------------------------------------------
async function searchMemory(tenantId, agentRole, embedding, {
  matchThreshold = 0.45,
  matchCount = 20,
} = {}) {
  const rows = await sbRpc('agent_memory_search', {
    p_tenant_id: tenantId,
    p_agent_role: agentRole,
    p_query_embed: toPgVectorLiteral(embedding),
    p_match_threshold: matchThreshold,
    p_match_count: matchCount,
  });
  return Array.isArray(rows) ? rows : [];
}

// ----------------------------------------------------------------------------
// Tenant resolver (mirrors jarvis-voice.js logic)
// ----------------------------------------------------------------------------
async function resolveTenantIdForAuthUser(authUserId) {
  const rows = await sbGet(
    `jarvis_users?select=tenant_id&auth_user_id=eq.${authUserId}&limit=1`
  );
  if (!rows || rows.length === 0) return null;
  return rows[0].tenant_id;
}

// ----------------------------------------------------------------------------
// CORS helper
// ----------------------------------------------------------------------------
function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// ----------------------------------------------------------------------------
// Format helper — turn lessons into the PRIOR LEARNINGS system-prompt block
// ----------------------------------------------------------------------------
function formatLessonsAsSystemBlock(role, lessons) {
  if (!Array.isArray(lessons) || lessons.length === 0) return '';
  const head = `--- PRIOR LEARNINGS (${role}) ---\n`
    + `These ${lessons.length} lessons were learned by prior ${role} instances on this tenant. `
    + `Apply them before asking Heath or repeating mistakes.\n`;
  const body = lessons.map((m, i) => {
    const badge = m.validation_status === 'heath_approved' ? '[HEATH-OK] ' : '';
    const cat = m.category ? `(${m.category}) ` : '';
    return `${i + 1}. ${badge}${cat}${m.title}\n   ${String(m.content).slice(0, 600)}`;
  }).join('\n');
  return head + body + '\n--- END PRIOR LEARNINGS ---\n';
}

export {
  VALID_AGENT_ROLES,
  VALID_CATEGORIES,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  OPENAI_API_KEY,
  sbGet,
  sbPost,
  sbPatch,
  sbRpc,
  embedText,
  toPgVectorLiteral,
  findDuplicate,
  incrementUsage,
  bumpLastUsed,
  searchMemory,
  resolveTenantIdForAuthUser,
  applyCors,
  formatLessonsAsSystemBlock,
};
