// Vercel Serverless Function: /api/integrations-docuseal-connect
// POST { apiKey: string }
// Authorization: Bearer <supabase user JWT>
//
// Connects the member's OWN DocuSeal account. DocuSeal has no OAuth flow
// — the member generates an API key in their own DocuSeal account
// (Settings > API) and pastes it in here. This endpoint:
//   1. Validates the key LIVE against DocuSeal's API (api/_lib/docuseal-
//      health.js) — never stores an unvalidated key.
//   2. Encrypts it (api/_lib/secret-crypto.js, AES-256-GCM) and upserts
//      user_integrations (user_id, oauth_provider='docuseal').
//   3. Never echoes the key back in the response.
//
// From this point on, api/esign-create.js / api/esign-download.js /
// api/fill-form-via-docuseal.js resolve THIS member's key via
// api/_lib/docuseal-client.js's resolveDocusealApiKeyForUser() instead of
// the shared DOCUSEAL_API_KEY env var (Heath's account).
//
// Owner: Carter, 2026-10-01 (member integrations + setup wizard build).

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');
const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { checkRateLimit, RateLimitError, clientIpFromReq } = require('./_middleware/rateLimit');
const { checkDocusealKey } = require('./_lib/docuseal-health');
const { encryptSecret } = require('./_lib/secret-crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'POST, OPTIONS', headers: 'Content-Type, Authorization' });
}

async function upsertDocusealRow(userId, encryptedKey) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/user_integrations?on_conflict=user_id,oauth_provider`,
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        user_id: userId,
        oauth_provider: 'docuseal',
        docuseal_api_key_encrypted: encryptedKey,
        last_check_status: 'connected',
        last_check_detail: null,
        last_checked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    },
  );
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`user_integrations upsert failed (${r.status}): ${text.slice(0, 200)}`);
  }
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
    await checkRateLimit(ip, 'integrations-docuseal-connect', 10, 60 * 60 * 1000);
    await checkRateLimit(userId, 'integrations-docuseal-connect-user', 10, 60 * 60 * 1000);

    const body = req.body || {};
    // DocuSeal API keys are long opaque tokens — generous max length, no
    // other shape assumption (DocuSeal doesn't document a fixed format).
    const apiKey = sanitizeString(body.apiKey, { maxLength: 500 });
    if (!apiKey) {
      throw new ValidationError('apiKey is required.');
    }

    const check = await checkDocusealKey(apiKey);
    if (!check.ok) {
      return res.status(422).json({
        ok: false,
        error: check.status === 'invalid_key'
          ? "That API key didn't work. Double-check it in your DocuSeal account under Settings > API."
          : `Could not reach DocuSeal to verify that key: ${check.detail || 'unknown error'}`,
      });
    }

    let encrypted;
    try {
      encrypted = encryptSecret(apiKey);
    } catch (err) {
      console.error('[integrations-docuseal-connect] encryption failed (category only):', err && err.message);
      return res.status(500).json({ ok: false, error: 'Could not securely store that key — try again shortly.' });
    }

    await upsertDocusealRow(userId, encrypted);

    return res.status(200).json({ ok: true, connected: true, provider: 'docuseal' });
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(err.status || 400).json({ ok: false, error: err.message });
    }
    if (err instanceof RateLimitError) {
      return res.status(429).json({ ok: false, error: 'Too many attempts — try again in a bit.' });
    }
    console.error('[integrations-docuseal-connect] error:', err && err.message);
    return res.status(500).json({ ok: false, error: 'Could not connect your DocuSeal account.' });
  }
};
