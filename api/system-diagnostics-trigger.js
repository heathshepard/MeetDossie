// Vercel Serverless Function: /api/system-diagnostics-trigger
// ============================================================================
// Lets Heath fire a new diagnostic run on demand from the Jarvis HUD. The
// actual diagnostic work happens inside api/cron-dossie-full-diagnostic which
// has a 300s budget — we proxy to it with the CRON_SECRET so the same code
// path runs whether it's the daily cron or a manual trigger.
//
// POST /api/system-diagnostics-trigger
//   Body: { surface?: 'dossie' }
//
// Auth: Bearer Supabase JWT (must be a jarvis user on the owning tenant).
//
// Returns:
//   200 { ok: true, diagnostic_id, overall_status, totals }
//   401 unauthenticated, 403 not on tenant, 502 inner cron failed
//
// Note: this blocks until the diagnostic returns. Diagnostic runs typically
// take 60-180s; we set maxDuration to 300s so Vercel won't kill us early.
//
// Owner: Ridge (ridge_1, 2026-06-20).

const { verifySupabaseToken } = require('./_middleware/auth.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

module.exports.config = { api: { bodyParser: true }, maxDuration: 300 };

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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

// Invoke the diagnostic by calling the handler directly. That way we don't
// have to round-trip through Vercel's HTTP layer (and lose the timeout
// budget). We construct a minimal req/res harness.
function makeMockReq(headers, query, body) {
  return { headers, query: query || {}, body: body || {}, method: 'POST' };
}
function makeMockRes() {
  const state = { status: 200, body: null, headers: {}, headersSent: false };
  return {
    _state: state,
    status(c) { state.status = c; return this; },
    setHeader(k, v) { state.headers[k] = v; },
    json(b) {
      state.body = b;
      state.headersSent = true;
      return this;
    },
    send(b) {
      state.body = b;
      state.headersSent = true;
      return this;
    },
    end(b) {
      if (b != null) state.body = b;
      state.headersSent = true;
      return this;
    },
  };
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }
  if (!CRON_SECRET) {
    return res.status(503).json({ ok: false, error: 'cron_secret_missing' });
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

  // Anti-thrash: refuse if a diagnostic was started <60s ago for this tenant
  try {
    const recent = await sbGet(
      `system_diagnostics?select=id,started_at,overall_status&tenant_id=eq.${tenantId}&order=started_at.desc&limit=1`
    );
    if (recent && recent[0]) {
      const ageMs = Date.now() - new Date(recent[0].started_at).getTime();
      if (ageMs < 60000 && recent[0].overall_status === 'running') {
        return res.status(429).json({
          ok: false,
          error: 'diagnostic_already_running',
          existing: recent[0],
        });
      }
    }
  } catch { /* ignore */ }

  // Direct-call the diagnostic handler (in-process).
  const diagnosticHandler = require('./cron-dossie-full-diagnostic.js');
  const mockReq = makeMockReq(
    {
      authorization: `Bearer ${CRON_SECRET}`,
    },
    { tenant_id: tenantId },
    {}
  );
  const mockRes = makeMockRes();

  try {
    await diagnosticHandler(mockReq, mockRes);
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'diagnostic_crashed', detail: err.message });
  }

  const innerStatus = mockRes._state.status;
  const innerBody = mockRes._state.body;
  if (innerStatus >= 400 || !innerBody || !innerBody.ok) {
    return res.status(innerStatus >= 400 ? innerStatus : 502).json({
      ok: false,
      error: 'diagnostic_failed',
      inner_status: innerStatus,
      inner_body: innerBody,
    });
  }
  return res.status(200).json(innerBody);
};
