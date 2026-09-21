// api/_lib/member-memory.js
// ============================================================================
// Shared helpers for Dossie's per-subscriber memory store (public.member_memory).
//
// Mirrors the shape of api/_lib/agent-memory.js (the internal agent shared
// memory pool, locked 2026-06-22) but keyed on a MEMBER, not an agent role,
// and CommonJS so it can be required from api/chat.js.
//
// SECURITY — read before extending this file.
// `user_id` is NEVER accepted as a parameter to any exported function here
// in a way that lets a caller supply someone else's id and get their memory
// back. Every function takes userId as an explicit argument that callers
// must derive from verifySupabaseToken(req) — never from req.body, a tool
// input, or anything else the caller controls. This is the exact shape of
// the 2026-09-17 impersonation bug (security-mt-acting-user-impersonation-
// 2026-09-17): identity from a parameter instead of the verified session.
//
// Owner: Carter, 2026-09-21.
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const VALID_CATEGORIES = new Set([
  'preference', 'workflow', 'communication_style', 'contact',
  'financial_fact', 'deal_fact', 'other',
]);

// Preference-shaped categories may be learned silently (source='inferred').
// Everything else that names a person/money/file fact must go through
// pending_confirmation — see the migration header for the full rationale.
const SILENTLY_LEARNABLE_CATEGORIES = new Set(['preference', 'workflow', 'communication_style']);

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

async function sbDelete(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=representation',
    },
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`sbDelete ${path} -> ${res.status} ${errBody.slice(0, 250)}`);
  }
  return res.json();
}

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

async function embedText(text) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
  const trimmed = String(text || '').slice(0, 8000);
  if (!trimmed) throw new Error('empty embed input');

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: trimmed }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`embed_failed ${res.status} ${body.slice(0, 250)}`);
  }
  const json = await res.json();
  const vec = json && json.data && json.data[0] && json.data[0].embedding;
  if (!Array.isArray(vec) || vec.length !== 1536) throw new Error('embed_invalid_dim');
  return vec;
}

function toPgVectorLiteral(arr) {
  return '[' + arr.map((n) => Number(n).toFixed(6)).join(',') + ']';
}

async function findDuplicate(userId, category, embedding, threshold = 0.92) {
  const rows = await sbRpc('member_memory_find_duplicate', {
    p_user_id: userId,
    p_category: category,
    p_query_embed: toPgVectorLiteral(embedding),
    p_threshold: threshold,
  });
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

// Only ever searches status='active' rows (enforced inside the RPC itself) —
// this is the mechanical guarantee that a pending_confirmation fact cannot
// be loaded into a reply before the member confirms it.
async function searchMemory(userId, embedding, { matchThreshold = 0.40, matchCount = 12 } = {}) {
  const rows = await sbRpc('member_memory_search', {
    p_user_id: userId,
    p_query_embed: toPgVectorLiteral(embedding),
    p_match_threshold: matchThreshold,
    p_match_count: matchCount,
  });
  return Array.isArray(rows) ? rows : [];
}

async function bumpUsage(memoryIds) {
  if (!Array.isArray(memoryIds) || memoryIds.length === 0) return;
  const inList = memoryIds.map((id) => `"${id}"`).join(',');
  try {
    // Read-modify-write per row so usage_count actually increments (a single
    // PATCH across many ids can only set a literal, not increment each row).
    const rows = await sbGet(`member_memory?select=id,usage_count&id=in.(${inList})`);
    await Promise.all((rows || []).map((r) =>
      sbPatch(`member_memory?id=eq.${r.id}`, {
        usage_count: (r.usage_count || 0) + 1,
        last_used_at: new Date().toISOString(),
      }).catch(() => {})
    ));
  } catch (_) {
    // Non-fatal — recall still worked even if the usage bump failed.
  }
}

// Format loaded memories into the small, bounded system-prompt block chat.js
// injects. Deliberately terse — this must never crowd out the conversation.
function formatMemoryAsSystemBlock(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return '';
  const head = `MEMBER MEMORY — what Dossie has learned about THIS member across past conversations (confirmed preferences/facts only; unconfirmed items are never included here):\n`;
  const body = memories.slice(0, 8).map((m) => `- (${m.category}) ${m.title}: ${String(m.content).slice(0, 300)}`).join('\n');
  const tail = `\nTreat these as background you already know about the member, not as verified facts about a specific deal — a "preference"/"workflow" item may be stated as what it is (their known habit), but a "financial_fact"/"deal_fact"/"contact" item drawn from memory still needs to be re-confirmed against the actual dossier/document before you state it as verified on a specific file, per CALIBRATION above.`;
  return head + body + tail;
}

module.exports = {
  VALID_CATEGORIES,
  SILENTLY_LEARNABLE_CATEGORIES,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  OPENAI_API_KEY,
  sbGet,
  sbPost,
  sbPatch,
  sbDelete,
  sbRpc,
  embedText,
  toPgVectorLiteral,
  findDuplicate,
  searchMemory,
  bumpUsage,
  formatMemoryAsSystemBlock,
};
