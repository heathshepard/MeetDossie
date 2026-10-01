// api/_lib/pricing-tiers.js
// Central map of Stripe Price ID -> Dossie plan name ('founding' | 'solo' | 'team').
// Single source of truth so stripe-webhook.js, complete-onboarding.js, and
// create-checkout-session.js can never drift on what a given price ID means.
//
// Added 2026-08-22 when Solo/Team live checkout was wired up — before this,
// Solo ($149/mo) and Team ($349/mo) had no real Stripe price IDs, and every
// caller of this map defaulted unknown price IDs to 'founding'. Founding's
// price ID is fixed/closed and never changes, so it stays hardcoded like it
// always has.
//
// Environment (Solo/Team price IDs, Prod+Preview):
//   STRIPE_PRICE_SOLO_MONTHLY, STRIPE_PRICE_SOLO_ANNUAL,
//   STRIPE_PRICE_TEAM_MONTHLY, STRIPE_PRICE_TEAM_ANNUAL

const FOUNDING_PRICE_ID = 'price_1TPxxNL920SKTEEiN7Gphq8T';

const SOLO_MONTHLY_PRICE_ID = process.env.STRIPE_PRICE_SOLO_MONTHLY || null;
const SOLO_ANNUAL_PRICE_ID = process.env.STRIPE_PRICE_SOLO_ANNUAL || null;
const TEAM_MONTHLY_PRICE_ID = process.env.STRIPE_PRICE_TEAM_MONTHLY || null;
const TEAM_ANNUAL_PRICE_ID = process.env.STRIPE_PRICE_TEAM_ANNUAL || null;

const PRICE_TIERS = {
  [FOUNDING_PRICE_ID]: 'founding',
};
if (SOLO_MONTHLY_PRICE_ID) PRICE_TIERS[SOLO_MONTHLY_PRICE_ID] = 'solo';
if (SOLO_ANNUAL_PRICE_ID) PRICE_TIERS[SOLO_ANNUAL_PRICE_ID] = 'solo';
if (TEAM_MONTHLY_PRICE_ID) PRICE_TIERS[TEAM_MONTHLY_PRICE_ID] = 'team';
if (TEAM_ANNUAL_PRICE_ID) PRICE_TIERS[TEAM_ANNUAL_PRICE_ID] = 'team';

// What create-checkout-session.js sells. billing_period 'annual' means a
// single once-a-year charge: 15% off the annualized monthly rate (Heath's
// explicit call, 2026-08-23 — NOT the $39/$119-derived totals this map
// shipped with for a few hours, which were wrong and got deactivated).
//   Solo:  $149/mo x 12 = $1,788/yr annualized -> 15% off = $1,519.80/yr
//   Team:  $349/mo x 12 = $4,188/yr annualized -> 15% off = $3,559.80/yr
// See docs/PRICING-HISTORY.md for the correction record.
const CHECKOUT_PRICE_IDS = {
  solo: { monthly: SOLO_MONTHLY_PRICE_ID, annual: SOLO_ANNUAL_PRICE_ID },
  team: { monthly: TEAM_MONTHLY_PRICE_ID, annual: TEAM_ANNUAL_PRICE_ID },
};

// Resolves a Stripe price ID to a plan name. Unrecognized price IDs fall
// back to 'founding' to preserve pre-2026-08-22 behavior everywhere this was
// already inlined — callers that care should check `recognized`.
function tierForPriceId(priceId) {
  if (priceId && PRICE_TIERS[priceId]) {
    return { tier: PRICE_TIERS[priceId], recognized: true };
  }
  return { tier: 'founding', recognized: false };
}

// DISPLAY_PRICING — authoritative numbers for any prompt/fact-block/UI copy
// that states a price in words (not just a Stripe price ID). Mirrors
// CLAUDE.md Section 5 exactly; CLAUDE.md is still the source of truth —
// update both together. Added 2026-10-01 after stale $39/$119 annual
// figures (a pre-2026-08-23 wrong basis) were found hand-copied into
// api/jarvis-context-load.js and api/_lib/sage-verified-facts.js with no
// shared constant to catch the drift. New pricing copy should read from
// this object instead of hardcoding numbers again.
const DISPLAY_PRICING = {
  solo: {
    monthly: 149,
    annualMonthlyEquivalent: 126.65,
    annualTotal: 1519.80,
  },
  team: {
    monthly: 349,
    seatsIncluded: 3,
    maxSeats: 8,
    extraSeatPrice: 79.99,
    annualMonthlyEquivalent: 296.65,
    annualTotal: 3559.80,
  },
  founding: {
    monthly: 29,
    status: 'closed',
    closedDate: '2026-08-04',
    existingMembersLockedForLife: 8,
  },
};

module.exports = { FOUNDING_PRICE_ID, PRICE_TIERS, CHECKOUT_PRICE_IDS, tierForPriceId, DISPLAY_PRICING };
