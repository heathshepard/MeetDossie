'use strict';

// api/_lib/subscription-status-map.test.js
// Run: node --test api/_lib/subscription-status-map.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { mapStripeSubscriptionStatus } = require('./subscription-status-map');

test('active maps to active', () => {
  assert.equal(mapStripeSubscriptionStatus('active'), 'active');
});

test('trialing maps to its own trialing status, not active', () => {
  // This is the exact bug the task called out: before this module existed,
  // a Solo/Team subscription.updated event never even reached the mapping
  // (price-ID guard skipped it), and even the founding-only path historically
  // risked folding trialing into active. It must not.
  assert.equal(mapStripeSubscriptionStatus('trialing'), 'trialing');
  assert.notEqual(mapStripeSubscriptionStatus('trialing'), 'active');
});

test('past_due maps to past_due', () => {
  assert.equal(mapStripeSubscriptionStatus('past_due'), 'past_due');
});

test('unpaid maps to past_due', () => {
  assert.equal(mapStripeSubscriptionStatus('unpaid'), 'past_due');
});

test('canceled (Stripe spelling) maps to cancelled (this DB\'s spelling)', () => {
  assert.equal(mapStripeSubscriptionStatus('canceled'), 'cancelled');
});

test('unknown/future Stripe statuses pass through raw rather than being guessed at', () => {
  assert.equal(mapStripeSubscriptionStatus('incomplete'), 'incomplete');
  assert.equal(mapStripeSubscriptionStatus('paused'), 'paused');
});
