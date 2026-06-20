// POST /api/team/tc-request-cancel
// DOD-A-10 (cancel): admin cancels a pending TC consent request

const { preflight, verifyBearer, getServiceClient, sendError } = require('../_lib/team-auth');

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  try {
    const { user: caller } = await verifyBearer(req);
    const body = req.body || {};
    const requestId = body.request_id;
    if (!requestId) return res.status(400).json({ ok: false, error: 'request_id required' });

    const supabase = getServiceClient();
    const { error } = await supabase.rpc('cancel_tc_consent_request', {
      p_request_id: requestId,
      p_acting_user_id: caller.id,
    });
    if (error) {
      console.error('[tc-request-cancel] RPC error:', error.message);
      return res.status(400).json({ ok: false, error: error.message });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    return sendError(res, err);
  }
};
