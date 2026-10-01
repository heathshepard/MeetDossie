// Vercel Serverless Function: /api/mark-connections-wizard-done
// POST {}
// Authorization: Bearer <supabase user JWT>
//
// Marks profiles.connections_wizard_completed = true for the authed member
// — called whether the member finishes the Connections wizard OR
// explicitly skips it, same "don't re-nag" semantics as
// iabs_defaults_completed. Read back by api/get-agent-defaults.js
// (defaults.connections_wizard_completed).
//
// Owner: Carter, 2026-10-01 (member integrations + setup wizard build).

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');
const { checkRateLimit, RateLimitError, clientIpFromReq } = require('./_middleware/rateLimit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
    await checkRateLimit(clientIpFromReq(req), 'mark-connections-wizard-done', 30, 60 * 60 * 1000);

    const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        connections_wizard_completed: true,
        connections_wizard_completed_at: new Date().toISOString(),
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`profiles patch failed (${r.status}): ${text.slice(0, 160)}`);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return res.status(429).json({ ok: false, error: 'Too many attempts — try again shortly.' });
    }
    console.error('[mark-connections-wizard-done] error:', err && err.message);
    return res.status(500).json({ ok: false, error: 'Could not save.' });
  }
};
