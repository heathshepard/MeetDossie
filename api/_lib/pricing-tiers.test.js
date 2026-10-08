'use strict';

// api/_lib/pricing-tiers.test.js
//
// tierForPriceId's `recognized` flag became load-bearing for real gating logic
// on 2026-09-26 (free-trial rollout) — api/stripe-webhook.js's
// handleSubscriptionCreated / handleSubscriptionUpdated now use it to decide
// whether to process a Solo/Team subscription event at all (previously those
// functions were hardcoded to only ever look at FOUNDING_PRICE_ID, which
// meant every Solo/Team subscription.created/updated event was silently
// dropped). This locks the contract down: recognized prices are processed,
// unrecognized ones (nonexistent price, or an add-on price, which has its own
// dedicated handler) are correctly skipped rather than misfiled as founding.
//
// Run: node --test api/_lib/pricing-tiers.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function freshPricingTiers(env) {
  const PATH = require.resolve('./pricing-tiers');
  delete require.cache[PATH];
  const prev = {
    STRIPE_PRICE_SOLO_MONTHLY: process.env.STRIPE_PRICE_SOLO_MONTHLY,
    STRIPE_PRICE_SOLO_ANNUAL: process.env.STRIPE_PRICE_SOLO_ANNUAL,
    STRIPE_PRICE_TEAM_MONTHLY: process.env.STRIPE_PRICE_TEAM_MONTHLY,
    STRIPE_PRICE_TEAM_ANNUAL: process.env.STRIPE_PRICE_TEAM_ANNUAL,
  };
  Object.assign(process.env, env);
  const mod = require('./pricing-tiers');
  Object.keys(prev).forEach((k) => {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  });
  delete require.cache[PATH];
  return mod;
}

test('the founding price is always recognized, with no env config needed', () => {
  const { tierForPriceId, FOUNDING_PRICE_ID } = freshPricingTiers({});
  const { tier, recognized } = tierForPriceId(FOUNDING_PRICE_ID);
  assert.equal(tier, 'founding');
  assert.equal(recognized, true);
});

test('a configured Solo price resolves to solo and is recognized', () => {
  const { tierForPriceId } = freshPricingTiers({ STRIPE_PRICE_SOLO_MONTHLY: 'price_solo_test_123' });
  const { tier, recognized } = tierForPriceId('price_solo_test_123');
  assert.equal(tier, 'solo');
  assert.equal(recognized, true);
});

test('a configured Team price resolves to team and is recognized', () => {
  const { tierForPriceId } = freshPricingTiers({ STRIPE_PRICE_TEAM_ANNUAL: 'price_team_test_456' });
  const { tier, recognized } = tierForPriceId('price_team_test_456');
  assert.equal(tier, 'team');
  assert.equal(recognized, true);
});

test('an unrecognized price (e.g. an add-on price, or unset/null) is NOT recognized — callers must skip it, not treat it as founding', () => {
  const { tierForPriceId } = freshPricingTiers({});
  const a = tierForPriceId('price_some_addon_id_not_in_the_map');
  assert.equal(a.recognized, false);
  const b = tierForPriceId(null);
  assert.equal(b.recognized, false);
});
