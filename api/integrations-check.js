// Vercel Serverless Function: /api/integrations-check
// POST { provider: 'google_gmail' | 'microsoft_graph' | 'docuseal' }
// Authorization: Bearer <supabase user JWT>
//
// On-demand LIVE health check for exactly one of this member's
// connections — the "Check connection" button in Settings > Connections
// and the Connections wizard's health step. Unlike api/integrations-status,
// this one real network call per invocation, which is why it's a separate
// endpoint and not folded into status (status must stay cheap and
// automatic; this one is deliberate and member-triggered, rate-limited).
//
// Reuses the existing per-provider health modules — no parallel system:
//   google_gmail    -> api/_lib/member-google-health.js (wraps
//                       google-refresh-ladder.js, same ladder Heath's own
//                       account uses)
//   microsoft_graph -> api/_lib/microsoft-token-health.js (wraps
//                       api/_lib/microsoft-oauth.js's existing refresh)
//   docuseal        -> api/_lib/docuseal-health.js (GET /templates?limit=1
//                       with the member's own decrypted key)
//
// Persists the outcome to user_integrations.last_check_status /
// last_check_detail / last_checked_at so api/integrations-status.js's
// cache-only reads pick it up immediately.
//
// Owner: Carter, 2026-10-01 (member integrations + setup wizard build).

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');
const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { checkRateLimit, RateLimitError, clientIpFromReq } = require('./_middleware/rateLimit');
const { checkMemberGoogleHealth } = require('./_lib/member-google-health');
const { checkMicrosoftTokenHealth } = require('./_lib/microsoft-token-health');
const { checkDocusealKey } = require('./_lib/docuseal-health');
const { resolveDocusealApiKeyForUser } = require('./_lib/docuseal-client');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PROVIDERS = new Set(['google_gmail', 'microsoft_graph', 'docuseal']);

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'POST, OPTIONS', headers: 'Content-Type, Authorization' });
}

async function persistCheckResult(userId, provider, status, detail) {
  await fetch(
    `${SUPABASE_URL}/rest/v1/user_integrations?user_id=eq.${encodeURIComponent(userId)}&oauth_provider=eq.${encodeURIComponent(provider)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        last_check_status: status,
        last_check_detail: detail || null,
        last_checked_at: new Date().toISOString(),
      }),
    },
  ).catch((err) => console.warn('[integrations-check] persist failed:', err && err.message));
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
    await checkRateLimit(ip, 'integrations-check', 20, 60 * 60 * 1000);
    await checkRateLimit(userId, 'integrations-check-user', 20, 60 * 60 * 1000);

    const body = req.body || {};
    const provider = sanitizeString(body.provider, { maxLength: 50 });
    if (!provider || !PROVIDERS.has(provider)) {
      throw new ValidationError(`provider must be one of: ${Array.from(PROVIDERS).join(', ')}`);
    }

    let result;
    if (provider === 'google_gmail') {
      result = await checkMemberGoogleHealth(userId);
    } else if (provider === 'microsoft_graph') {
      result = await checkMicrosoftTokenHealth(userId);
    } else {
      const { apiKey, source } = await resolveDocusealApiKeyForUser(userId);
      if (source !== 'member') {
        result = { status: 'never_connected', detail: 'You have not connected your own DocuSeal account yet.' };
      } else {
        const check = await checkDocusealKey(apiKey);
        result = check.ok
          ? { status: 'connected' }
          : { status: check.status === 'invalid_key' ? 'expired' : 'error', detail: check.detail };
      }
    }

    await persistCheckResult(userId, provider, result.status, result.detail || null);

    return res.status(200).json({
      ok: true,
      provider,
      status: result.status,
      detail: result.detail || null,
      accountEmail: result.accountEmail || null,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(err.status || 400).json({ ok: false, error: err.message });
    }
    if (err instanceof RateLimitError) {
      return res.status(429).json({ ok: false, error: 'Too many checks — try again in a bit.' });
    }
    console.error('[integrations-check] error:', err && err.message);
    return res.status(500).json({ ok: false, error: 'Health check failed.' });
  }
};
