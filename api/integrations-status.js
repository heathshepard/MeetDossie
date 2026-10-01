// Vercel Serverless Function: /api/integrations-status
// GET (Authorization: Bearer <supabase user JWT>)
//   -> { ok: true, integrations: {
//          google_gmail:    { connected, status, accountEmail, lastCheckedAt, lastCheckDetail },
//          microsoft_graph: { connected, status, accountEmail, lastCheckedAt, lastCheckDetail },
//          docuseal:        { connected, status, accountEmail, lastCheckedAt, lastCheckDetail, usingSharedAccount }
//        } }
//
// Cache-only read — NO live provider calls. Reads whatever
// api/google-oauth-callback.js / api/microsoft-oauth-callback.js /
// api/integrations-docuseal-connect.js already wrote, plus the cached
// last_check_status/last_checked_at columns from the most recent on-demand
// check (api/integrations-check.js). This endpoint backs both the
// Connections wizard and the Settings > Connections panel, and both need
// to render instantly on page load — a live refresh/health-check attempt
// per provider per page view would burn rate limit against Google/
// Microsoft/DocuSeal for every member on every reload.
//
// status values: 'connected' | 'expired' | 'error' | 'never_connected'.
// A row with no last_check_status yet (connected but never actively
// checked) reports 'connected' optimistically — presence of a
// refresh_token/api key is the only signal available until the member (or
// the wizard) triggers api/integrations-check.js.
//
// Owner: Carter, 2026-10-01 (member integrations + setup wizard build).

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PROVIDERS = ['google_gmail', 'microsoft_graph', 'docuseal'];

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'GET, OPTIONS', headers: 'Content-Type, Authorization' });
}

function emptyRow(provider) {
  return {
    provider,
    connected: false,
    status: 'never_connected',
    accountEmail: null,
    lastCheckedAt: null,
    lastCheckDetail: null,
  };
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ ok: false, error: 'Origin not allowed.' });
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Server not configured.' });
  }

  let userId;
  try {
    const auth = await verifySupabaseToken(req);
    userId = auth.userId;
  } catch (err) {
    const status = err instanceof AuthError && err.status ? err.status : 401;
    return res.status(status).json({ ok: false, error: 'Unauthorized' });
  }

  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/user_integrations`
    + `?select=oauth_provider,google_email,microsoft_email,docuseal_account_email,refresh_token,docuseal_api_key_encrypted,last_check_status,last_check_detail,last_checked_at`
    + `&user_id=eq.${encodeURIComponent(userId)}&oauth_provider=in.(${PROVIDERS.join(',')})`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
  );
  const rows = resp.ok ? await resp.json().catch(() => []) : [];

  const out = {};
  for (const p of PROVIDERS) out[p] = emptyRow(p);

  for (const row of (Array.isArray(rows) ? rows : [])) {
    const p = row.oauth_provider;
    if (!PROVIDERS.includes(p)) continue;

    const hasCredential = p === 'docuseal' ? !!row.docuseal_api_key_encrypted : !!row.refresh_token;
    if (!hasCredential) continue; // pruned/never-really-connected row — leave as never_connected

    const accountEmail = p === 'google_gmail' ? row.google_email
      : p === 'microsoft_graph' ? row.microsoft_email
      : row.docuseal_account_email;

    out[p] = {
      provider: p,
      connected: true,
      status: row.last_check_status || 'connected',
      accountEmail: accountEmail || null,
      lastCheckedAt: row.last_checked_at || null,
      lastCheckDetail: row.last_check_detail || null,
    };
  }

  out.docuseal.usingSharedAccount = !out.docuseal.connected;

  return res.status(200).json({ ok: true, integrations: out });
};
