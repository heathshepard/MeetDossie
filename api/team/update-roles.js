// POST /api/team/update-roles
// DOD-A-9: admin grants/revokes individual roles on a member
//
// Body: { member_id, add_roles?: string[], remove_roles?: string[] }
//
// Seat cap + billing sync (added 2026-08-23): granting 'agent' via a role
// edit is the same billing event as inviting someone straight into 'agent'
// — without this, an admin could bypass invite.js's 8-seat cap entirely by
// inviting someone as tc-only then upgrading them here. Same cap check,
// same non-blocking Stripe sync as team-invite-core.js.

const { preflight, verifyBearer, getServiceClient, sendError } = require('../_lib/team-auth');
const { getSeatCounts } = require('../_lib/team-seat-count');
const { syncTeamSeatBilling } = require('../_lib/team-seat-billing');
const Stripe = require('stripe');

let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  _stripe = new Stripe(key, { apiVersion: '2024-06-20' });
  return _stripe;
}

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

    // Hard seat cap — only matters when this edit is GRANTING 'agent' to a
    // member who doesn't already hold it (re-granting an already-active
    // agent role is a no-op for seat count, so it's never blocked here).
    const grantingAgent = Array.isArray(addRoles) && addRoles.includes('agent');
    let orgId = null;
    if (grantingAgent) {
      const { data: memberRow } = await supabase
        .from('organization_members_with_roles')
        .select('org_id, roles')
        .eq('member_id', memberId)
        .maybeSingle();
      orgId = memberRow ? memberRow.org_id : null;
      const alreadyAgent = memberRow && Array.isArray(memberRow.roles) && memberRow.roles.includes('agent');
      if (orgId && !alreadyAgent) {
        const counts = await getSeatCounts(supabase, orgId);
        if (!counts.ok) {
          console.error('[update-roles] seat count check failed:', counts.error);
          return res.status(500).json({ ok: false, error: 'seat limit check failed' });
        }
        if (counts.at_or_over_limit) {
          return res.status(400).json({
            ok: false,
            error: `Your team is at its ${counts.max}-seat limit (${counts.included} included + ${counts.max - counts.included} extra at $${(counts.seat_price_cents / 100).toFixed(2)}/seat). Remove a member first, or email heath@meetdossie.com to raise the limit.`,
          });
        }
      }
    }

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

    // Real Stripe billing sync — non-blocking, only when 'agent' was touched
    // either direction (grant or revoke both change paid-seat count).
    const touchesAgent = (Array.isArray(addRoles) && addRoles.includes('agent'))
      || (Array.isArray(removeRoles) && removeRoles.includes('agent'));
    if (touchesAgent) {
      try {
        let targetOrgId = orgId;
        if (!targetOrgId) {
          const { data: memberRow2 } = await supabase
            .from('organization_members')
            .select('org_id')
            .eq('id', memberId)
            .maybeSingle();
          targetOrgId = memberRow2 ? memberRow2.org_id : null;
        }
        if (targetOrgId) {
          const stripe = getStripe();
          if (stripe) {
            const billingResult = await syncTeamSeatBilling(supabase, stripe, targetOrgId);
            if (!billingResult.ok) {
              console.warn('[update-roles] seat billing sync failed:', billingResult.error);
            } else if (billingResult.synced) {
              console.log('[update-roles] seat billing synced: org=', targetOrgId, 'quantity=', billingResult.quantity);
            }
          }
        }
      } catch (err) {
        console.warn('[update-roles] seat billing sync threw:', err && err.message);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return sendError(res, err);
  }
};
