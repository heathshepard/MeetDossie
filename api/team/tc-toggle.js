// POST /api/team/tc-toggle
// DOD-G-7: agent toggles TC consent from Settings → Email Delegation
//
// Body: { org_id, tc_user_id, grant: boolean }
// Returns: { ok: true, authorization_id }

const { preflight, verifyBearer, getServiceClient, clientIp, sendError } = require('../_lib/team-auth');

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const { user: caller } = await verifyBearer(req);
    const body = req.body || {};
    const orgId = body.org_id;
    const tcUserId = body.tc_user_id;
    const grant = body.grant === true;

    if (!orgId || !tcUserId) {
      return res.status(400).json({ ok: false, error: 'org_id and tc_user_id required' });
    }
    if (typeof body.grant !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'grant must be boolean' });
    }

    const supabase = getServiceClient();
    const ip = clientIp(req);
    const ua = (req.headers && req.headers['user-agent']) || null;

    const { data, error } = await supabase.rpc('toggle_tc_authorization', {
      p_org_id: orgId,
      p_tc_user_id: tcUserId,
      p_grant: grant,
      p_ip: ip,
      p_user_agent: ua,
      p_acting_user_id: caller.id,
    });
    if (error) {
      console.error('[tc-toggle] RPC error:', error.message);
      return res.status(400).json({ ok: false, error: error.message });
    }
    return res.status(200).json({ ok: true, authorization_id: data });
  } catch (err) {
    return sendError(res, err);
  }
};
