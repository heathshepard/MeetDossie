// POST /api/team/update-roles
// DOD-A-9: admin grants/revokes individual roles on a member
//
// Body: { member_id, add_roles?: string[], remove_roles?: string[] }

const { preflight, verifyBearer, getServiceClient, sendError } = require('../_lib/team-auth');

const VALID_ROLES = new Set(['agent', 'admin', 'tc']);

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
    const addRoles = Array.isArray(body.add_roles) ? body.add_roles : null;
    const removeRoles = Array.isArray(body.remove_roles) ? body.remove_roles : null;

    if (!memberId) return res.status(400).json({ ok: false, error: 'member_id required' });
    if (!addRoles && !removeRoles) {
      return res.status(400).json({ ok: false, error: 'at least one of add_roles or remove_roles required' });
    }
    if (addRoles && !addRoles.every((r) => VALID_ROLES.has(r))) {
      return res.status(400).json({ ok: false, error: 'invalid role in add_roles' });
    }
    if (removeRoles && !removeRoles.every((r) => VALID_ROLES.has(r))) {
      return res.status(400).json({ ok: false, error: 'invalid role in remove_roles' });
    }

    const supabase = getServiceClient();
    const { error } = await supabase.rpc('update_member_roles', {
      p_member_id: memberId,
      p_add_roles: addRoles,
      p_remove_roles: removeRoles,
      p_acting_user_id: caller.id,
    });
    if (error) {
      console.error('[update-roles] RPC error:', error.message);
      return res.status(400).json({ ok: false, error: error.message });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    return sendError(res, err);
  }
};
