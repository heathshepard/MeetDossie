// api/_lib/team-org.js
// Single source of truth for invoking the create_org_with_founder RPC over
// PostgREST (POST /rest/v1/rpc/create_org_with_founder). The RPC itself lives
// in supabase/migrations/20260620120000_multitenant_phase4_rpcs_and_solo_upgrade.sql.
//
// Why this exists: api/team/create-org.js already calls this RPC via
// supabase-js's `.rpc()`, but it requires a Bearer JWT (verifyBearer) because
// it's a browser-facing endpoint. api/complete-onboarding.js runs
// server-to-server right after a Stripe checkout completes — there is no
// browser session at that point, so it cannot call create-org.js's HTTP
// handler. This helper calls the EXACT SAME underlying RPC, same params,
// just over the REST client each of those files already uses, so the two
// callers never drift on what the RPC expects.
//
// supabaseFetchFn: an (path, init) => Promise<json> helper that already
// carries the service-role key (matches the supabaseFetch already defined in
// complete-onboarding.js / stripe-webhook.js).

async function createOrgWithFounder(supabaseFetchFn, {
  name,
  tier,
  founderUserId,
  founderRoles,
  seatPriceCents,
  parentOrgId = null,
  upgradeFromSolo = false,
  stripeCustomerId = null,
  actingUserId,
}) {
  const body = {
    p_name: name,
    p_tier: tier,
    p_founder_user_id: founderUserId,
    p_founder_roles: founderRoles,
    // Matches api/team/create-org.js's own default (7900 = $79/seat for team).
    p_seat_price_cents: seatPriceCents != null ? seatPriceCents : (tier === 'team' ? 7900 : 0),
    p_parent_org_id: parentOrgId,
    p_upgrade_from_solo: upgradeFromSolo === true,
    p_stripe_customer_id: stripeCustomerId,
    // Service-role callers have no auth.uid() — the RPC requires an explicit
    // acting user for its permission checks and audit trail.
    p_acting_user_id: actingUserId != null ? actingUserId : founderUserId,
  };
  // PostgREST RPC returns the scalar return value directly (org_id UUID as a
  // bare JSON string), not wrapped in an array/object.
  const data = await supabaseFetchFn('/rest/v1/rpc/create_org_with_founder', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data; // org_id (UUID string)
}

module.exports = { createOrgWithFounder };
