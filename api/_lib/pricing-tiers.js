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

module.exports = { FOUNDING_PRICE_ID, PRICE_TIERS, CHECKOUT_PRICE_IDS, tierForPriceId };
