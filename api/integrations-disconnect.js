// Vercel Serverless Function: /api/integrations-disconnect
// POST { provider: 'google_gmail' | 'microsoft_graph' | 'docuseal' }
// Authorization: Bearer <supabase user JWT>
//
// Removes the member's own connection row. A service-role endpoint rather
// than a direct client-side DELETE (user_integrations does have a
// self_delete RLS policy, but routing every write path through an API
// endpoint keeps one consistent place to log/rate-limit disconnects and to
// add provider-specific cleanup later, e.g. revoking a Google grant
// server-side).
//
// After this call, api/integrations-status.js reports that provider as
// never_connected again, and (for docuseal) api/_lib/docuseal-client.js's
// resolveDocusealApiKeyForUser() falls back to the shared DOCUSEAL_API_KEY.
//
// Owner: Carter, 2026-10-01 (member integrations + setup wizard build).

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');
const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { checkRateLimit, RateLimitError, clientIpFromReq } = require('./_middleware/rateLimit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PROVIDERS = new Set(['google_gmail', 'microsoft_graph', 'docuseal']);

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'POST, OPTIONS', headers: 'Content-Type, Authorization' });
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ ok: false, error: 'Origin not allowed.' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
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

  try {
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'integrations-disconnect', 20, 60 * 60 * 1000);

    const body = req.body || {};
    const provider = sanitizeString(body.provider, { maxLength: 50 });
    if (!provider || !PROVIDERS.has(provider)) {
      throw new ValidationError(`provider must be one of: ${Array.from(PROVIDERS).join(', ')}`);
    }

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/user_integrations?user_id=eq.${encodeURIComponent(userId)}&oauth_provider=eq.${encodeURIComponent(provider)}`,
      {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: 'return=minimal',
        },
      },
    );
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`delete failed (${r.status}): ${text.slice(0, 160)}`);
    }

    return res.status(200).json({ ok: true, provider, disconnected: true });
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(err.status || 400).json({ ok: false, error: err.message });
    }
    if (err instanceof RateLimitError) {
      return res.status(429).json({ ok: false, error: 'Too many attempts — try again in a bit.' });
    }
    console.error('[integrations-disconnect] error:', err && err.message);
    return res.status(500).json({ ok: false, error: 'Could not disconnect that integration.' });
  }
};
