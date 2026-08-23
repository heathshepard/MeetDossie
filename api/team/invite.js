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
//
// The actual invite logic lives in ../_lib/team-invite-core.js — shared with
// api/chat.js so a team lead adding a member by voice/text and a team lead
// using the "Add team member" form in TeamView.jsx go through the exact same
// code path and can never diverge.

const { preflight, verifyBearer, getServiceClient, sendError } = require('../_lib/team-auth');
const { inviteTeamMember } = require('../_lib/team-invite-core');

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const { user: caller } = await verifyBearer(req);
    const body = req.body || {};
    const supabase = getServiceClient();

    const result = await inviteTeamMember(supabase, {
      orgId: body.org_id,
      email: body.email,
      roles: body.roles,
      callerId: caller.id,
    });

    if (!result.ok) {
      return res.status(result.status || 400).json({ ok: false, error: result.error });
    }

    return res.status(200).json({
      ok: true,
      member_id: result.member_id,
      was_existing_user: result.was_existing_user,
      invitee_user_id: result.invitee_user_id,
    });
  } catch (err) {
    return sendError(res, err);
  }
};
