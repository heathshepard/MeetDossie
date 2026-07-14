// Vercel Serverless Function: /api/get-agent-defaults
// GET — fetch agent's saved IABS broker defaults from profiles table
// Authorization: Bearer <supabase user JWT>
//
// Response on success:
// {
//   ok: true,
//   defaults: {
//     broker_name, broker_license_number, broker_phone, broker_email,
//     broker_address_street, broker_address_city, broker_address_state,
//     broker_address_zip, supervising_broker_name, supervising_broker_license,
//     supervising_broker_phone, agent_license_number, agent_phone,
//     agent_relationship_type, iabs_defaults_completed
//   }
// }
//
// Response on missing defaults:
// { ok: true, defaults: null }
//
// Error responses:
// { ok: false, error: "message", statusCode: number }

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');
const { checkRateLimit, RateLimitError, clientIpFromReq } = require('./_middleware/rateLimit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'GET, OPTIONS' });
}

async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    // Rate limit check
    await checkRateLimit(clientIpFromReq(req), 'get-agent-defaults', 100);

    // Verify Supabase JWT
    let userId;
    try {
      const tokenResult = await verifySupabaseToken(req);
      userId = tokenResult.userId;
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.statusCode).json({ ok: false, error: err.message });
        return;
      }
      throw err;
    }

    // Fetch agent's profile with IABS defaults
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=broker_name,broker_license_number,broker_phone,broker_email,broker_address_street,broker_address_city,broker_address_state,broker_address_zip,supervising_broker_name,supervising_broker_license,supervising_broker_phone,agent_license_number,agent_phone,agent_relationship_type,iabs_defaults_completed&limit=1`,
      {
        method: 'GET',
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!fetchRes.ok) {
      const text = await fetchRes.text();
      console.error(`[get-agent-defaults] Supabase fetch failed (${fetchRes.status}): ${text.slice(0, 300)}`);
      res.status(500).json({ ok: false, error: 'Failed to fetch defaults' });
      return;
    }

    const rows = await fetchRes.json();
    const defaults = rows && rows.length > 0 ? rows[0] : null;

    res.status(200).json({ ok: true, defaults });
  } catch (err) {
    console.error('[get-agent-defaults] Uncaught error:', err && err.message);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}

module.exports = handler;
