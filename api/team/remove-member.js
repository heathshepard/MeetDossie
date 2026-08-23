// POST /api/team/remove-member
// DOD-A-8 (admin removal) + DOD-G-6 (self leave)
//
// Body: { member_id }
// The RPC enforces: caller is the target user (self-leave) OR caller is org admin.
// The last-admin trigger prevents orphaning an org.
//
// Real Stripe billing sync (added 2026-08-23): after a successful removal,
// syncs the org founder's real Stripe subscription's extra-seat item
// quantity back down — see ../_lib/team-seat-billing.js. Non-blocking: a
// Stripe failure here logs a warning but never undoes the (already
// successful) roster removal.

const Stripe = require('stripe');
const { preflight, verifyBearer, getServiceClient, sendError } = require('../_lib/team-auth');
const { syncTeamSeatBilling } = require('../_lib/team-seat-billing');

let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  _stripe = new Stripe(key, { apiVersion: '2024-06-20' });
  return _stripe;
}

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

    // Look up org_id BEFORE removal — the RPC only takes member_id, and we
    // need org_id afterward to sync Stripe. (removed_at doesn't clear
    // org_id, so this would also work read after, but before is simpler and
    // avoids a race with any concurrent hard-delete elsewhere.)
    const { data: memberRow } = await supabase
      .from('organization_members')
      .select('org_id')
      .eq('id', memberId)
      .maybeSingle();

    const { error } = await supabase.rpc('remove_org_member', {
      p_member_id: memberId,
      p_acting_user_id: caller.id,
    });
    if (error) {
      console.error('[remove-member] RPC error:', error.message);
      return res.status(400).json({ ok: false, error: error.message });
    }

    if (memberRow && memberRow.org_id) {
      const stripe = getStripe();
      if (stripe) {
        try {
          const billingResult = await syncTeamSeatBilling(supabase, stripe, memberRow.org_id);
          if (!billingResult.ok) {
            console.warn('[remove-member] seat billing sync failed after removal:', billingResult.error);
          } else if (billingResult.synced) {
            console.log('[remove-member] seat billing synced after removal: org=', memberRow.org_id, 'quantity=', billingResult.quantity);
          }
        } catch (err) {
          console.warn('[remove-member] seat billing sync threw after removal:', err && err.message);
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return sendError(res, err);
  }
};
