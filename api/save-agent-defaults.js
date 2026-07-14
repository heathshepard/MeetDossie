// Vercel Serverless Function: /api/save-agent-defaults
// POST — save agent's IABS broker defaults to profiles table
// Authorization: Bearer <supabase user JWT>
//
// Request body (all fields optional):
// {
//   broker_name, broker_license_number, broker_phone, broker_email,
//   broker_address_street, broker_address_city, broker_address_state,
//   broker_address_zip, supervising_broker_name, supervising_broker_license,
//   supervising_broker_phone, agent_license_number, agent_phone,
//   agent_relationship_type
// }
//
// Response on success:
// { ok: true, defaults: { ...saved fields... } }
//
// Error responses:
// { ok: false, error: "message", statusCode: number }

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');
const { checkRateLimit, RateLimitError, clientIpFromReq } = require('./_middleware/rateLimit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'POST, OPTIONS' });
}

async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    // Rate limit check
    await checkRateLimit(clientIpFromReq(req), 'save-agent-defaults', 50);

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

    const body = req.body || {};

    // Sanitize & validate inputs (all optional, safe defaults for empty)
    const sanitize = (v, maxLen = 500) =>
      v ? sanitizeString(String(v).trim(), { maxLength: maxLen }) : null;

    const updatePayload = {
      broker_name: sanitize(body.broker_name, 200),
      broker_license_number: sanitize(body.broker_license_number, 50),
      broker_phone: sanitize(body.broker_phone, 20),
      broker_email: sanitize(body.broker_email, 255),
      broker_address_street: sanitize(body.broker_address_street, 255),
      broker_address_city: sanitize(body.broker_address_city, 100),
      broker_address_state: sanitize(body.broker_address_state, 2) || 'TX',
      broker_address_zip: sanitize(body.broker_address_zip, 10),
      supervising_broker_name: sanitize(body.supervising_broker_name, 200),
      supervising_broker_license: sanitize(body.supervising_broker_license, 50),
      supervising_broker_phone: sanitize(body.supervising_broker_phone, 20),
      agent_license_number: sanitize(body.agent_license_number, 50),
      agent_phone: sanitize(body.agent_phone, 20),
      agent_relationship_type: validateRelationshipType(body.agent_relationship_type),
      iabs_defaults_completed: true,
    };

    // Remove null values to avoid overwriting existing data unintentionally
    const updateData = Object.fromEntries(
      Object.entries(updatePayload).filter(([, v]) => v !== null)
    );

    if (Object.keys(updateData).length === 0) {
      res.status(400).json({ ok: false, error: 'No defaults provided' });
      return;
    }

    // Always set flag on save
    updateData.iabs_defaults_completed = true;

    // Update profiles record
    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(updateData),
      }
    );

    if (!updateRes.ok) {
      const text = await updateRes.text();
      console.error(`[save-agent-defaults] Supabase update failed (${updateRes.status}): ${text.slice(0, 300)}`);
      res.status(500).json({ ok: false, error: 'Failed to save defaults' });
      return;
    }

    const rows = await updateRes.json();
    const saved = rows && rows.length > 0 ? rows[0] : null;

    console.log(`[save-agent-defaults] Saved IABS defaults for user ${userId}`);
    res.status(200).json({ ok: true, defaults: saved });
  } catch (err) {
    console.error('[save-agent-defaults] Uncaught error:', err && err.message);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}

function validateRelationshipType(value) {
  if (!value) return null;
  const v = String(value).toLowerCase().trim();
  const valid = ['buyer_agent', 'seller_agent', 'intermediary'];
  return valid.includes(v) ? v : null;
}

module.exports = handler;
