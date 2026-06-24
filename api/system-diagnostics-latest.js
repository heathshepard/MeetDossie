// Vercel Serverless Function: /api/system-diagnostics-latest
// ============================================================================
// Returns the most recent diagnostic run for the caller's tenant, plus its
// associated check rows. Powers the DOSSIE HEALTH panel in the Jarvis HUD.
//
// GET /api/system-diagnostics-latest?surface=dossie
//
// Auth: Bearer Supabase JWT (any signed-in jarvis user).
//
// Returns:
//   200 {
//     ok: true,
//     diagnostic: { id, overall_status, totals, improvements, started_at, ... },
//     checks: [ { category, check_key, label, status, severity, evidence, ... } ],
//     screenshot_urls: { "<screenshot_path>": "<signed url>" }
//   }
//   200 { ok: true, diagnostic: null }  // no runs yet
//
// Owner: Ridge (ridge_1, 2026-06-20).

const { verifySupabaseToken } = require('./_middleware/auth.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'system-diagnostics';
const SIGN_URL_TTL = 3600;

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

async function signStoragePaths(paths) {
  if (!paths || paths.length === 0) return {};
  const out = {};
  // Supabase signed URL endpoint takes one path at a time, so we loop.
  for (const p of paths) {
    try {
      const r = await fetch(
        `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${p}`,
        {
          method: 'POST',
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ expiresIn: SIGN_URL_TTL }),
        }
      );
      if (r.ok) {
        const d = await r.json();
        if (d && d.signedURL) {
          out[p] = `${SUPABASE_URL}/storage/v1${d.signedURL}`;
        }
      }
    } catch { /* ignore */ }
  }
  return out;
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

  // Latest diagnostic for this tenant + surface
  let diag = null;
  try {
    const rows = await sbGet(
      `system_diagnostics?select=*&tenant_id=eq.${tenantId}&surface=eq.${surface}&order=started_at.desc&limit=1`
    );
    diag = (rows && rows[0]) || null;
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'diagnostic_query_failed', detail: err.message });
  }

  if (!diag) {
    return res.status(200).json({ ok: true, diagnostic: null, checks: [], screenshot_urls: {} });
  }

  // Pull the checks
  let checks = [];
  try {
    checks = await sbGet(
      `system_diagnostic_checks?select=*&diagnostic_id=eq.${diag.id}&order=category.asc,status.asc`
    );
  } catch (err) {
    // Non-fatal — return what we have
    checks = [];
  }

  // Sign storage URLs
  const paths = checks.map((c) => c.screenshot_path).filter(Boolean);
  let signed = {};
  try {
    signed = await signStoragePaths(paths);
  } catch { /* ignore */ }

  return res.status(200).json({
    ok: true,
    diagnostic: diag,
    checks,
    screenshot_urls: signed,
  });
};
