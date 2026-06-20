// GET /api/team/roster?org_id=...
// DOD-A-1 admin roster page data
//
// Returns: { ok: true, members: [{ member_id, user_id, email, joined_at, removed_at, roles[] }] }
// Auth: caller must hold Admin role on the org (enforced inside get_org_roster RPC)

const { preflight, verifyBearer, getServiceClient, sendError } = require('../_lib/team-auth');

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const { user } = await verifyBearer(req);
    const orgId = (req.query && req.query.org_id) || null;
    if (!orgId || typeof orgId !== 'string') {
      return res.status(400).json({ ok: false, error: 'org_id required' });
    }

    const supabase = getServiceClient();

    // Use a service-role client but pass the caller's user_id via a transient
    // session header. The RPC is SECURITY DEFINER and checks _mt_user_is_org_admin.
    // We replicate the admin check here at the API layer for an early 403.
    const { data: isAdmin, error: adminErr } = await supabase.rpc('_mt_user_is_org_admin', {
      p_user_id: user.id,
      p_org_id: orgId,
    });
    if (adminErr) {
      console.error('[roster] admin check error:', adminErr.message);
      return res.status(500).json({ ok: false, error: 'authorization check failed' });
    }
    if (!isAdmin) {
      return res.status(403).json({ ok: false, error: 'not an admin on this org' });
    }

    // Fetch roster directly via service-role select (RPC requires auth.uid())
    const { data: members, error: rosterErr } = await supabase
      .from('organization_members_with_roles')
      .select('member_id, user_id, joined_at, removed_at, roles')
      .eq('org_id', orgId);

    if (rosterErr) {
      console.error('[roster] fetch error:', rosterErr.message);
      return res.status(500).json({ ok: false, error: rosterErr.message });
    }

    // Enrich with emails (service-role can read auth.users)
    const userIds = (members || []).map((m) => m.user_id);
    let emailMap = {};
    if (userIds.length > 0) {
      const { data: usersData } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (usersData && usersData.users) {
        emailMap = Object.fromEntries(usersData.users.map((u) => [u.id, u.email]));
      }
    }

    const enriched = (members || []).map((m) => ({
      ...m,
      email: emailMap[m.user_id] || null,
    }));

    return res.status(200).json({ ok: true, members: enriched });
  } catch (err) {
    return sendError(res, err);
  }
};
