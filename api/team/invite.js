// POST /api/team/invite
// DOD-A-7: admin invites a member with a role bundle
//
// Body: { org_id, email, roles[] } where roles ⊆ {agent, admin, tc}
// Flow:
//   1. Verify caller is admin on org (via RPC check)
//   2. If invitee email exists in auth.users → reactivate/insert member row + roles
//   3. If invitee doesn't exist → send Supabase admin invite (magic link),
//      then upon their first sign-in they call /api/team/accept-invite to attach
//      themselves. For simplicity in v1, we create the auth.users row immediately
//      via admin.inviteUserByEmail and write the member row.
//
// Returns: { ok: true, member_id, was_existing_user }

const { preflight, verifyBearer, getServiceClient, sendError } = require('../_lib/team-auth');

const VALID_ROLES = new Set(['agent', 'admin', 'tc']);
const EMAIL_RE = /^[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,253}\.[A-Za-z]{2,}$/;

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
    const emailRaw = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const roles = Array.isArray(body.roles) ? body.roles : [];

    if (!orgId || typeof orgId !== 'string') {
      return res.status(400).json({ ok: false, error: 'org_id required' });
    }
    if (!emailRaw || !EMAIL_RE.test(emailRaw)) {
      return res.status(400).json({ ok: false, error: 'valid email required' });
    }
    if (roles.length === 0 || !roles.every((r) => VALID_ROLES.has(r))) {
      return res.status(400).json({ ok: false, error: 'roles must be a non-empty subset of agent/admin/tc' });
    }

    const supabase = getServiceClient();

    // Admin check first (fast 403)
    const { data: isAdmin, error: adminErr } = await supabase.rpc('_mt_user_is_org_admin', {
      p_user_id: caller.id,
      p_org_id: orgId,
    });
    if (adminErr) {
      console.error('[invite] admin check error:', adminErr.message);
      return res.status(500).json({ ok: false, error: 'authorization check failed' });
    }
    if (!isAdmin) {
      return res.status(403).json({ ok: false, error: 'not an admin on this org' });
    }

    // Look up invitee in auth.users (service-role)
    let inviteeUserId = null;
    let wasExisting = false;

    const { data: existingUsers } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
    // listUsers doesn't filter by email server-side; we need a different approach.
    // Use admin.getUserByEmail if available, else fall back to a profile lookup.
    try {
      const { data: byEmail } = await supabase.auth.admin.getUserByEmail
        ? await supabase.auth.admin.getUserByEmail(emailRaw)
        : { data: null };
      if (byEmail && byEmail.user) {
        inviteeUserId = byEmail.user.id;
        wasExisting = true;
      }
    } catch (e) {
      // ignore — fall through to invite path
    }

    // Fallback: search profiles by email if available
    if (!inviteeUserId) {
      try {
        const { data: profileMatch } = await supabase
          .from('profiles')
          .select('id')
          .eq('email', emailRaw)
          .maybeSingle();
        if (profileMatch && profileMatch.id) {
          inviteeUserId = profileMatch.id;
          wasExisting = true;
        }
      } catch (_) { /* profiles table may not have email column */ }
    }

    // If still not found, invite by email (creates auth.users + sends magic link)
    if (!inviteeUserId) {
      const redirectTo = `https://meetdossie.com/app?invited_to_org=${encodeURIComponent(orgId)}`;
      const { data: inviteResult, error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(emailRaw, {
        redirectTo,
      });
      if (inviteErr) {
        console.error('[invite] inviteUserByEmail error:', inviteErr.message);
        return res.status(400).json({ ok: false, error: inviteErr.message });
      }
      if (inviteResult && inviteResult.user) {
        inviteeUserId = inviteResult.user.id;
      }
    }

    if (!inviteeUserId) {
      return res.status(500).json({ ok: false, error: 'failed to resolve invitee user_id' });
    }

    // Attach to org
    const { data: memberId, error: rpcErr } = await supabase.rpc('invite_member_with_roles', {
      p_org_id: orgId,
      p_invitee_user_id: inviteeUserId,
      p_roles: roles,
      p_acting_user_id: caller.id,
    });
    if (rpcErr) {
      console.error('[invite] RPC error:', rpcErr.message);
      return res.status(400).json({ ok: false, error: rpcErr.message });
    }

    return res.status(200).json({
      ok: true,
      member_id: memberId,
      was_existing_user: wasExisting,
      invitee_user_id: inviteeUserId,
    });
  } catch (err) {
    return sendError(res, err);
  }
};
