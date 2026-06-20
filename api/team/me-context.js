// GET /api/team/me-context
// Returns the current user's org context (or null if Solo).
// Used by the React app to know which org (if any) to scope to and what roles
// to show in the UI.
//
// Returns: { ok, context: { member_id, org_id, org_name, org_tier, parent_org_id, roles[], joined_at } | null }

const { preflight, verifyBearer, getServiceClient, sendError } = require('../_lib/team-auth');

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  try {
    const { user: caller } = await verifyBearer(req);
    const supabase = getServiceClient();

    // Query directly via service-role (mirrors get_my_org_context but bypassing auth.uid())
    const { data: rows, error } = await supabase
      .from('organization_members_with_roles')
      .select(`
        member_id,
        org_id,
        user_id,
        roles,
        joined_at,
        removed_at,
        organizations:org_id ( id, name, tier, parent_org_id, archived_at )
      `)
      .eq('user_id', caller.id)
      .is('removed_at', null);

    if (error) {
      console.error('[me-context] select error:', error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    const active = (rows || []).find((r) => r.organizations && !r.organizations.archived_at);
    if (!active) {
      return res.status(200).json({ ok: true, context: null });
    }

    return res.status(200).json({
      ok: true,
      context: {
        member_id: active.member_id,
        org_id: active.org_id,
        org_name: active.organizations.name,
        org_tier: active.organizations.tier,
        parent_org_id: active.organizations.parent_org_id,
        roles: active.roles || [],
        joined_at: active.joined_at,
      },
    });
  } catch (err) {
    return sendError(res, err);
  }
};
