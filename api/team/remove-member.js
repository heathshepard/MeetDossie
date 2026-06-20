// POST /api/team/remove-member
// DOD-A-8 (admin removal) + DOD-G-6 (self leave)
//
// Body: { member_id }
// The RPC enforces: caller is the target user (self-leave) OR caller is org admin.
// The last-admin trigger prevents orphaning an org.

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
    const memberId = body.member_id;
    if (!memberId) return res.status(400).json({ ok: false, error: 'member_id required' });

    const supabase = getServiceClient();
    const { error } = await supabase.rpc('remove_org_member', {
      p_member_id: memberId,
      p_acting_user_id: caller.id,
    });
    if (error) {
      console.error('[remove-member] RPC error:', error.message);
      return res.status(400).json({ ok: false, error: error.message });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    return sendError(res, err);
  }
};
