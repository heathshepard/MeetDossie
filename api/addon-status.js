// Vercel Serverless Function: /api/addon-status
// GET (Authorization: Bearer <supabase user JWT>)
//   -> { ok: true, emailIntegrationEnabled: bool, isFoundingActive: bool,
//        priceCents: 1500, foundingPriceCents: 750 }
//
// Small read-only endpoint so the Settings > Add-ons UI and the Talk-to-Dossie
// side panel can show the REAL entitlement state instead of a hardcoded
// "Coming Soon". Reads via service role (not a client-side RLS query) since no
// RLS SELECT policy is confirmed to exist yet on subscriptions for this shape
// — same caution as every other API route in this repo that touches
// subscriptions.
//
// Owner: Carter, 2026-08-22 (SV-ENG-EMAIL-INTEGRATION-ADDON)

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PRICE_CENTS = 1500;
const FOUNDING_PRICE_CENTS = 750; // exactly 50% off, per Terms of Service §4.2

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'GET, OPTIONS', headers: 'Content-Type, Authorization' });
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
    `${SUPABASE_URL}/rest/v1/subscriptions?select=plan,status,email_integration_enabled&user_id=eq.${encodeURIComponent(userId)}&order=updated_at.desc&limit=1`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
  );
  const rows = resp.ok ? await resp.json().catch(() => []) : [];
  const sub = Array.isArray(rows) ? rows[0] : null;

  const isFoundingActive = !!sub && sub.plan === 'founding' && ['active', 'internal', 'pending_onboarding'].includes(sub.status);

  return res.status(200).json({
    ok: true,
    emailIntegrationEnabled: !!(sub && sub.email_integration_enabled),
    isFoundingActive,
    priceCents: PRICE_CENTS,
    foundingPriceCents: FOUNDING_PRICE_CENTS,
  });
};
