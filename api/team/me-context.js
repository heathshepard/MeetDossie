// GET /api/team/me-context
// Returns the current user's org context (or null if Solo).
// Used by the React app to know which org (if any) to scope to and what roles
// to show in the UI.
//
// Returns: { ok, context: { member_id, org_id, org_name, org_tier, parent_org_id, roles[], joined_at, lead_name } | null }
//
// lead_name (added 2026-08-23, first-run welcome banner): only populated when
// the caller does NOT hold 'admin' themselves — the org's own founder/lead
// doesn't need to be told who their lead is. Best-effort (profiles.full_name,
// falling back to email); a lookup failure never blocks the base context
// response since it's cosmetic-only.

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

    const activeRoles = active.roles || [];
    let leadName = null;
    if (!activeRoles.includes('admin')) {
      try {
        const { data: rosterRows } = await supabase
          .from('organization_members_with_roles')
          .select('user_id, roles')
          .eq('org_id', active.org_id)
          .is('removed_at', null);
        const adminMember = (rosterRows || []).find((r) => Array.isArray(r.roles) && r.roles.includes('admin'));
        if (adminMember) {
          const { data: profileRow } = await supabase
            .from('profiles')
            .select('full_name, email')
            .eq('id', adminMember.user_id)
            .maybeSingle();
          leadName = (profileRow && (profileRow.full_name || profileRow.email)) || null;
        }
      } catch (err) {
        console.warn('[me-context] lead_name lookup failed (non-blocking):', err && err.message);
      }
    }

    return res.status(200).json({
      ok: true,
      context: {
        member_id: active.member_id,
        org_id: active.org_id,
        org_name: active.organizations.name,
        org_tier: active.organizations.tier,
        parent_org_id: active.organizations.parent_org_id,
        roles: activeRoles,
        joined_at: active.joined_at,
        lead_name: leadName,
      },
    });
  } catch (err) {
    return sendError(res, err);
  }
};
