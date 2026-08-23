// api/_lib/team-seat-billing.js
//
// Closes the "is the overage number just informational" gap Heath flagged
// 2026-08-23: keeps a Team org founder's REAL Stripe subscription in sync
// with their real seat count, so their invoice actually reflects headcount
// instead of billing.js's overage math being display-only.
//
// Model (per Heath's direction): one extra subscription ITEM (not a second
// subscription — that's the different pattern api/create-addon-checkout-session.js
// uses for Email Integration) on the team lead's EXISTING Team subscription,
// price = STRIPE_PRICE_TEAM_EXTRA_SEAT ($35/mo), quantity = seats beyond the
// 3 included (0-5, enforced by the 8-seat hard cap in team-invite-core.js).
// Stripe prorates the quantity change automatically — no proration math here.
//
// Called from api/team/invite.js (via team-invite-core.js) and
// api/team/remove-member.js, AFTER the roster change already succeeded.
// Must never fail the roster operation itself — a Stripe hiccup should not
// block adding/removing a team member. Every caller wraps this in try/catch
// and logs a warning on failure; see the call sites for the exact pattern.

const { getSeatCounts } = require('./team-seat-count');

const EXTRA_SEAT_PRICE_ID = process.env.STRIPE_PRICE_TEAM_EXTRA_SEAT || null;

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase service-role client
 * @param {import('stripe')} stripe initialized Stripe client
 * @param {string} orgId
 * @returns {Promise<{ok:true, synced:boolean, reason?:string, overage?:number,
 *   quantity?:number, subscription_id?:string} | {ok:false, error:string}>}
 */
async function syncTeamSeatBilling(supabase, stripe, orgId) {
  try {
    if (!EXTRA_SEAT_PRICE_ID) {
      return { ok: true, synced: false, reason: 'STRIPE_PRICE_TEAM_EXTRA_SEAT not configured' };
    }

    const { data: org, error: orgErr } = await supabase
      .from('organizations')
      .select('id, tier, created_by_user_id')
      .eq('id', orgId)
      .maybeSingle();
    if (orgErr) return { ok: false, error: orgErr.message };
    if (!org) return { ok: false, error: 'org not found' };
    if (org.tier !== 'team') {
      // Brokerage billing is a different, not-yet-built model (custom
      // pricing per CLAUDE.md Section 5) — don't touch it here.
      return { ok: true, synced: false, reason: `org tier is ${org.tier}, not team` };
    }
    if (!org.created_by_user_id) {
      return { ok: true, synced: false, reason: 'org has no created_by_user_id' };
    }

    // The team lead's real paid subscription — lives on `subscriptions`
    // (keyed by user_id), NOT on `organizations.stripe_subscription_id`
    // (that column exists but create_org_with_founder never populates it;
    // confirmed 2026-08-23, only stripe_customer_id is ever passed and it's
    // always null from both current callers).
    const { data: subRows, error: subErr } = await supabase
      .from('subscriptions')
      .select('id, stripe_subscription_id, status, plan')
      .eq('user_id', org.created_by_user_id)
      .eq('plan', 'team')
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(1);
    if (subErr) return { ok: false, error: subErr.message };
    const subRow = (subRows || [])[0];
    if (!subRow || !subRow.stripe_subscription_id) {
      return { ok: true, synced: false, reason: 'no active Team Stripe subscription linked to this org founder' };
    }

    const counts = await getSeatCounts(supabase, orgId);
    if (!counts.ok) return { ok: false, error: counts.error };
    const targetQuantity = counts.overage; // 0-5, already capped by the 8-seat hard limit

    const subscription = await stripe.subscriptions.retrieve(subRow.stripe_subscription_id);
    const existingItem = (subscription.items && subscription.items.data || [])
      .find((it) => it.price && it.price.id === EXTRA_SEAT_PRICE_ID);

    if (targetQuantity === 0) {
      if (!existingItem) {
        return { ok: true, synced: true, overage: 0, quantity: 0, subscription_id: subRow.stripe_subscription_id, reason: 'no extra-seat item to remove' };
      }
      await stripe.subscriptions.update(subRow.stripe_subscription_id, {
        items: [{ id: existingItem.id, deleted: true }],
        proration_behavior: 'create_prorations',
      });
      return { ok: true, synced: true, overage: 0, quantity: 0, subscription_id: subRow.stripe_subscription_id };
    }

    if (existingItem && existingItem.quantity === targetQuantity) {
      // Already correct — no-op, avoid an unnecessary Stripe write.
      return { ok: true, synced: true, overage: targetQuantity, quantity: existingItem.quantity, subscription_id: subRow.stripe_subscription_id, reason: 'already in sync' };
    }

    const itemUpdate = existingItem
      ? { id: existingItem.id, price: EXTRA_SEAT_PRICE_ID, quantity: targetQuantity }
      : { price: EXTRA_SEAT_PRICE_ID, quantity: targetQuantity };

    const updated = await stripe.subscriptions.update(subRow.stripe_subscription_id, {
      items: [itemUpdate],
      proration_behavior: 'create_prorations',
    });
    const newItem = (updated.items && updated.items.data || [])
      .find((it) => it.price && it.price.id === EXTRA_SEAT_PRICE_ID);

    return {
      ok: true,
      synced: true,
      overage: targetQuantity,
      quantity: newItem ? newItem.quantity : targetQuantity,
      subscription_id: subRow.stripe_subscription_id,
      subscription_item_id: newItem ? newItem.id : null,
    };
  } catch (err) {
    console.error('[team-seat-billing] syncTeamSeatBilling failed for org', orgId, ':', err && err.message);
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

module.exports = { syncTeamSeatBilling, EXTRA_SEAT_PRICE_ID };
