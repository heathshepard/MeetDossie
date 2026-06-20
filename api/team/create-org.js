// POST /api/team/create-org
// DOD-O-1 (team signup) + DOD-O-2 (Solo→Team upgrade) + DOD-S-7 (atomic backfill)
//
// Body: { name, tier ('team'|'brokerage'), founder_roles[], upgrade_from_solo?: bool }
// Auth: caller's Supabase JWT (the founder). Founder seats themselves.
//
// On success: { ok: true, org_id }

const { preflight, verifyBearer, getServiceClient, sendError } = require('../_lib/team-auth');

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const { user } = await verifyBearer(req);
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const tier = body.tier;
    const roles = Array.isArray(body.founder_roles) ? body.founder_roles : ['agent', 'admin'];
    const upgrade = body.upgrade_from_solo === true;

    if (!name || name.length < 2 || name.length > 200) {
      return res.status(400).json({ ok: false, error: 'Team name must be 2-200 characters.' });
    }
    if (!['team', 'brokerage'].includes(tier)) {
      return res.status(400).json({ ok: false, error: 'tier must be team or brokerage' });
    }
    if (!Array.isArray(roles) || roles.length === 0 || !roles.every((r) => ['agent', 'admin', 'tc'].includes(r))) {
      return res.status(400).json({ ok: false, error: 'invalid founder_roles' });
    }
    if (!roles.includes('admin')) {
      return res.status(400).json({ ok: false, error: 'founder must include admin role' });
    }

    const supabase = getServiceClient();
    const { data, error } = await supabase.rpc('create_org_with_founder', {
      p_name: name,
      p_tier: tier,
      p_founder_user_id: user.id,
      p_founder_roles: roles,
      p_seat_price_cents: tier === 'team' ? 7900 : 0,
      p_parent_org_id: null,
      p_upgrade_from_solo: upgrade,
      p_stripe_customer_id: null,
      p_acting_user_id: user.id,
    });
    if (error) {
      console.error('[create-org] RPC error:', error.message);
      return res.status(400).json({ ok: false, error: error.message });
    }

    return res.status(200).json({ ok: true, org_id: data });
  } catch (err) {
    return sendError(res, err);
  }
};
