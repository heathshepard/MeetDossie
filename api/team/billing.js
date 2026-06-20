// GET /api/team/billing?org_id=...
// DOD-B-4: returns paid seat count, free seat count, per-seat price, vault info.
//
// This is a READ endpoint — Stripe sync (subscription.update on role mutation)
// is a follow-on item (DOD-B-2/B-3 require a webhook reconciler).

const { preflight, verifyBearer, getServiceClient, sendError } = require('../_lib/team-auth');

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

    // Member rollup
    const { data: roster } = await supabase
      .from('organization_members_with_roles')
      .select('member_id, roles, removed_at')
      .eq('org_id', orgId);

    const active = (roster || []).filter((r) => !r.removed_at);
    const paidSeats = active.filter((r) => (r.roles || []).includes('agent')).length;
    const freeSeats = active.filter((r) => !(r.roles || []).includes('agent')).length;
    const monthlyCents = (org && org.seat_price_cents ? org.seat_price_cents : 7900) * paidSeats;

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
      seats: { paid: paidSeats, free: freeSeats, monthly_cents: monthlyCents },
      vault: vault || null,
    });
  } catch (err) {
    return sendError(res, err);
  }
};
