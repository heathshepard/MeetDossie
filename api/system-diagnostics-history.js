// Vercel Serverless Function: /api/system-diagnostics-history
// ============================================================================
// Returns the last N diagnostic runs (summary only — no individual checks) for
// the caller's tenant. Powers a sparkline / trend view in the HUD.
//
// GET /api/system-diagnostics-history?surface=dossie&limit=14
//
// Auth: Bearer Supabase JWT.
//
// Returns: 200 { ok: true, runs: [ { id, overall_status, totals, started_at, completed_at, duration_ms } ] }
//
// Owner: Ridge (ridge_1, 2026-06-20).

const { verifySupabaseToken } = require('./_middleware/auth.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports.config = { api: { bodyParser: false }, maxDuration: 10 };

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`sbGet ${path} -> ${r.status} ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function resolveTenantId(authUserId) {
  const rows = await sbGet(
    `jarvis_users?select=tenant_id&auth_user_id=eq.${authUserId}&limit=1`
  );
  if (!rows || rows.length === 0) return null;
  return rows[0].tenant_id;
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  let authUser;
  try {
    authUser = await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: err.message });
  }

  let tenantId;
  try {
    tenantId = await resolveTenantId(authUser.userId);
  } catch {
    return res.status(500).json({ ok: false, error: 'tenant_lookup_failed' });
  }
  if (!tenantId) {
    return res.status(403).json({ ok: false, error: 'no_jarvis_tenant' });
  }

  const surface = (req.query && req.query.surface) || 'dossie';
  const limit = Math.max(1, Math.min(60, parseInt((req.query && req.query.limit) || '14', 10)));

  try {
    const runs = await sbGet(
      `system_diagnostics?select=id,overall_status,totals,improvements,started_at,completed_at,duration_ms,trigger_source&tenant_id=eq.${tenantId}&surface=eq.${surface}&order=started_at.desc&limit=${limit}`
    );
    return res.status(200).json({ ok: true, runs });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'history_query_failed', detail: err.message });
  }
};
