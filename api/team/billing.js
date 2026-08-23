// GET /api/team/billing?org_id=...
// DOD-B-4: returns paid seat count, free seat count, per-seat price, vault info.
//
// Seat counting/overage math now lives in ../_lib/team-seat-count.js — the
// same function backs the hard cap enforcement in team-invite-core.js and
// the real Stripe subscription-item sync in team-seat-billing.js, so all
// three can never disagree on what "paid seat" or "overage" means.
//
// Stripe sync (subscription_item quantity updates on invite/remove) is now
// wired — see api/_lib/team-seat-billing.js, called from invite.js and
// remove-member.js. This endpoint stays read-only.

const { preflight, verifyBearer, getServiceClient, sendError } = require('../_lib/team-auth');
const { getSeatCounts } = require('../_lib/team-seat-count');

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  try {
    const { user: caller } = await verifyBearer(req);
    const orgId = (req.query && req.query.org_id) || null;
    if (!orgId) return res.status(400).json({ ok: false, error: 'org_id required' });

    const supabase = getServiceClient();
    const { data: isAdmin, error: adminErr } = await supabase.rpc('_mt_user_is_org_admin', {
      p_user_id: caller.id, p_org_id: orgId,
    });
    if (adminErr) return res.status(500).json({ ok: false, error: 'auth check failed' });
    if (!isAdmin) return res.status(403).json({ ok: false, error: 'not an admin' });

    // Org row
    const { data: org } = await supabase
      .from('organizations')
      .select('id, name, tier, seat_price_cents, seat_limit, stripe_customer_id, stripe_subscription_id')
      .eq('id', orgId)
      .maybeSingle();

    const counts = await getSeatCounts(supabase, orgId);
    if (!counts.ok) {
      return res.status(counts.status || 500).json({ ok: false, error: counts.error });
    }
    const monthlyCents = counts.overage * counts.seat_price_cents;

    // Vault
    const { data: vault } = await supabase
      .from('data_vault_subscriptions')
      .select('tier, storage_quota_bytes, monthly_price_cents, started_at, canceled_at, grace_period_ends_at')
      .eq('org_id', orgId)
      .is('canceled_at', null)
      .maybeSingle();

    return res.status(200).json({
      ok: true,
      org: org || null,
      seats: {
        paid: counts.paid,
        free: counts.free,
        included: counts.included,
        max: counts.max,
        overage: counts.overage,
        seat_price_cents: counts.seat_price_cents,
        monthly_cents: monthlyCents,
        over_seat_limit: counts.paid > counts.max,
        at_seat_limit: counts.at_or_over_limit,
      },
      vault: vault || null,
    });
  } catch (err) {
    return sendError(res, err);
  }
};
