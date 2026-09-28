'use strict';

// api/_lib/trial-config.test.js
// Run: node --test api/_lib/trial-config.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_TRIAL_DAYS,
  resolveTrialDays,
  resolveTrialRequireCard,
  buildTrialSessionFields,
} = require('./trial-config');

test('resolveTrialDays defaults to 14 when unset', () => {
  assert.equal(resolveTrialDays({}), 14);
  assert.equal(resolveTrialDays({}), DEFAULT_TRIAL_DAYS);
});

test('resolveTrialDays defaults to 14 for empty string', () => {
  assert.equal(resolveTrialDays({ TRIAL_DAYS: '' }), 14);
});

test('resolveTrialDays honors an explicit 0 (disables trial)', () => {
  assert.equal(resolveTrialDays({ TRIAL_DAYS: '0' }), 0);
});

test('resolveTrialDays honors a positive override', () => {
  assert.equal(resolveTrialDays({ TRIAL_DAYS: '30' }), 30);
  assert.equal(resolveTrialDays({ TRIAL_DAYS: '7' }), 7);
});

test('resolveTrialDays falls back to default on garbage input', () => {
  assert.equal(resolveTrialDays({ TRIAL_DAYS: 'banana' }), 14);
  assert.equal(resolveTrialDays({ TRIAL_DAYS: '-5' }), 14);
});

test('resolveTrialRequireCard defaults to true', () => {
  assert.equal(resolveTrialRequireCard({}), true);
});

test('resolveTrialRequireCard is false only for the literal string "false" (case-insensitive)', () => {
  assert.equal(resolveTrialRequireCard({ TRIAL_REQUIRE_CARD: 'false' }), false);
  assert.equal(resolveTrialRequireCard({ TRIAL_REQUIRE_CARD: 'FALSE' }), false);
  assert.equal(resolveTrialRequireCard({ TRIAL_REQUIRE_CARD: 'true' }), true);
  assert.equal(resolveTrialRequireCard({ TRIAL_REQUIRE_CARD: 'anything-else' }), true);
});

test('buildTrialSessionFields: TRIAL_DAYS=0 sends no trial_period_days and no payment_method_collection override', () => {
  const { subscriptionData, topLevel } = buildTrialSessionFields({ trialDays: 0, requireCard: true });
  assert.deepEqual(subscriptionData, {});
  assert.deepEqual(topLevel, {});
});

test('buildTrialSessionFields: default 14-day, card-required trial sets trial_period_days only', () => {
  const { subscriptionData, topLevel } = buildTrialSessionFields({ trialDays: 14, requireCard: true });
  assert.deepEqual(subscriptionData, { trial_period_days: 14 });
  assert.deepEqual(topLevel, {});
});

test('buildTrialSessionFields: trial + no-card-required sets payment_method_collection', () => {
  const { subscriptionData, topLevel } = buildTrialSessionFields({ trialDays: 14, requireCard: false });
  assert.deepEqual(subscriptionData, { trial_period_days: 14 });
  assert.deepEqual(topLevel, { payment_method_collection: 'if_required' });
});

test('buildTrialSessionFields: no-card-required is a no-op with no trial (card always required to charge today)', () => {
  const { subscriptionData, topLevel } = buildTrialSessionFields({ trialDays: 0, requireCard: false });
  assert.deepEqual(subscriptionData, {});
  assert.deepEqual(topLevel, {});
});
