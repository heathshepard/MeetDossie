// api/_lib/team-seat-count.js
//
// Single source of truth for "how many paid (agent-role) seats does this org
// have right now, and what does that mean for pricing/limits." Extracted
// 2026-08-23 from api/team/billing.js so the same counting logic backs:
//   1. billing.js's display math (what a team lead sees).
//   2. api/_lib/team-invite-core.js's hard seat-cap enforcement (blocks the
//      9th+ agent seat, both the UI invite form and the chat-driven
//      add_team_member action, since both call inviteTeamMember).
//   3. api/_lib/team-seat-billing.js's real Stripe subscription-item
//      quantity sync.
// All three must agree on what "paid seat" and "overage" mean — hence one
// function instead of three copies.
//
// Team plan (CLAUDE.md Section 5): 3 seats included in the base price, up to
// 5 more purchasable at $35/seat, 8 total max. "Seat" = active member
// holding the 'agent' role — mirrors billing.js's original paidSeats
// definition (Stripe billing counts only members with active 'agent' role,
// per the Phase 1 migration's own header comment).

const INCLUDED_SEATS = 3;
const MAX_SEATS = 8;
const DEFAULT_SEAT_PRICE_CENTS = 3500; // $35/seat overage

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase service-role client
 * @param {string} orgId
 * @returns {Promise<{ok:true, paid:number, free:number, included:number, max:number,
 *   overage:number, over_limit:number, at_or_over_limit:boolean, seat_price_cents:number}
 *   | {ok:false, status:number, error:string}>}
 */
async function getSeatCounts(supabase, orgId, { seatPriceCents } = {}) {
  const { data: org, error: orgErr } = await supabase
    .from('organizations')
    .select('id, seat_price_cents')
    .eq('id', orgId)
    .maybeSingle();
  if (orgErr) return { ok: false, status: 500, error: orgErr.message };
  if (!org) return { ok: false, status: 404, error: 'org not found' };

  const { data: roster, error: rosterErr } = await supabase
    .from('organization_members_with_roles')
    .select('member_id, roles, removed_at')
    .eq('org_id', orgId);
  if (rosterErr) return { ok: false, status: 500, error: rosterErr.message };

  const active = (roster || []).filter((r) => !r.removed_at);
  const paid = active.filter((r) => (r.roles || []).includes('agent')).length;
  const free = active.length - paid;
  const overage = Math.max(0, paid - INCLUDED_SEATS);
  const overLimit = Math.max(0, paid - MAX_SEATS);
  const resolvedSeatPriceCents = seatPriceCents != null
    ? seatPriceCents
    : ((org && org.seat_price_cents) ? org.seat_price_cents : DEFAULT_SEAT_PRICE_CENTS);

  return {
    ok: true,
    paid,
    free,
    included: INCLUDED_SEATS,
    max: MAX_SEATS,
    overage,
    over_limit: overLimit,
    at_or_over_limit: paid >= MAX_SEATS,
    seat_price_cents: resolvedSeatPriceCents,
  };
}

module.exports = { getSeatCounts, INCLUDED_SEATS, MAX_SEATS, DEFAULT_SEAT_PRICE_CENTS };
