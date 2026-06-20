// POST /api/team/tc-consent-consume
// DOD-G-8: agent clicks the one-tap link. NO authentication required —
// the token IS the credential.
//
// Body: { token }
// Returns: { ok, status: 'consumed'|'already_consumed'|'expired'|'revoked'|'not_found',
//            agent_email, tc_email, org_name }

const { preflight, getServiceClient, clientIp, sendError } = require('../_lib/team-auth');

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) return res.status(400).json({ ok: false, error: 'token required' });

    const supabase = getServiceClient();
    const ip = clientIp(req);
    const ua = (req.headers && req.headers['user-agent']) || null;

    const { data: rows, error } = await supabase.rpc('consume_tc_consent_token', {
      p_raw_token: token,
      p_ip: ip,
      p_user_agent: ua,
    });
    if (error) {
      console.error('[tc-consent-consume] RPC error:', error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) return res.status(500).json({ ok: false, error: 'RPC returned no row' });

    return res.status(200).json({
      ok: true,
      status: row.out_status,
      authorization_id: row.out_authorization_id,
      agent_email: row.out_agent_email,
      tc_email: row.out_tc_email,
      org_name: row.out_org_name,
    });
  } catch (err) {
    return sendError(res, err);
  }
};
