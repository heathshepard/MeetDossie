// api/_lib/team-invite-core.js
//
// Shared invite logic — extracted from api/team/invite.js so the exact same
// code path serves two callers:
//   1. api/team/invite.js — the HTTP endpoint (self-serve "Add team member"
//      form in TeamView.jsx).
//   2. api/chat.js — Dossie's chat, when a team-lead account tells Dossie in
//      plain language to add a team member. Calling this directly
//      (service-role, in-process) avoids an HTTP round trip back into the
//      same Vercel deployment and keeps the admin-gate logic in one place.
//
// Both callers MUST already know the caller is trying to act as orgId's
// admin — this module re-checks _mt_user_is_org_admin itself as a hard
// backstop (cheap RPC call) rather than trusting the caller's own gate, the
// same defense-in-depth pattern as org-dossiers.js / team-risk-rollup.js.

const VALID_ROLES = new Set(['agent', 'admin', 'tc']);
const EMAIL_RE = /^[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,253}\.[A-Za-z]{2,}$/;

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase service-role client
 * @param {{orgId: string, email: string, roles: string[], callerId: string}} params
 * @returns {Promise<{ok:true, member_id:string, was_existing_user:boolean, invitee_user_id:string}
 *   | {ok:false, status:number, error:string}>}
 */
async function inviteTeamMember(supabase, { orgId, email, roles, callerId }) {
  const emailRaw = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const roleList = Array.isArray(roles) ? roles : [];

  if (!orgId || typeof orgId !== 'string') return { ok: false, status: 400, error: 'org_id required' };
  if (!emailRaw || !EMAIL_RE.test(emailRaw)) return { ok: false, status: 400, error: 'valid email required' };
  if (roleList.length === 0 || !roleList.every((r) => VALID_ROLES.has(r))) {
    return { ok: false, status: 400, error: 'roles must be a non-empty subset of agent/admin/tc' };
  }
  if (!callerId) return { ok: false, status: 401, error: 'callerId required' };

  const { data: isAdmin, error: adminErr } = await supabase.rpc('_mt_user_is_org_admin', {
    p_user_id: callerId,
    p_org_id: orgId,
  });
  if (adminErr) {
    console.error('[team-invite-core] admin check error:', adminErr.message);
    return { ok: false, status: 500, error: 'authorization check failed' };
  }
  if (!isAdmin) return { ok: false, status: 403, error: 'not an admin on this org' };

  let inviteeUserId = null;
  let wasExisting = false;

  try {
    const { data: byEmail } = await supabase.auth.admin.getUserByEmail
      ? await supabase.auth.admin.getUserByEmail(emailRaw)
      : { data: null };
    if (byEmail && byEmail.user) {
      inviteeUserId = byEmail.user.id;
      wasExisting = true;
    }
  } catch (e) {
    // fall through to invite path
  }

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

  if (!inviteeUserId) {
    const redirectTo = `https://meetdossie.com/app?invited_to_org=${encodeURIComponent(orgId)}`;
    const { data: inviteResult, error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(emailRaw, {
      redirectTo,
    });
    if (inviteErr) {
      console.error('[team-invite-core] inviteUserByEmail error:', inviteErr.message);
      return { ok: false, status: 400, error: inviteErr.message };
    }
    if (inviteResult && inviteResult.user) {
      inviteeUserId = inviteResult.user.id;
    }
  }

  if (!inviteeUserId) return { ok: false, status: 500, error: 'failed to resolve invitee user_id' };

  const { data: memberId, error: rpcErr } = await supabase.rpc('invite_member_with_roles', {
    p_org_id: orgId,
    p_invitee_user_id: inviteeUserId,
    p_roles: roleList,
    p_acting_user_id: callerId,
  });
  if (rpcErr) {
    console.error('[team-invite-core] invite_member_with_roles RPC error:', rpcErr.message);
    return { ok: false, status: 400, error: rpcErr.message };
  }

  return { ok: true, member_id: memberId, was_existing_user: wasExisting, invitee_user_id: inviteeUserId };
}

module.exports = { inviteTeamMember, VALID_ROLES, EMAIL_RE };
