'use strict';

// api/_lib/trial-config.js
//
// Pure, testable free-trial config resolution — pulled out of
// api/create-checkout-session.js (2026-09-26) so the env-parsing and Stripe
// session-shape logic can be unit tested without spinning up the Stripe SDK
// or a real HTTP request. See api/create-checkout-session.test.js.
//
//   TRIAL_DAYS (default 14) — 0 disables the trial entirely, restoring
//     pre-2026-09-26 behavior exactly (card charged immediately, no
//     subscription_data.trial_period_days sent to Stripe at all).
//   TRIAL_REQUIRE_CARD (default true) — Heath's explicit call: 5 of 8
//     existing paying customers never logged in even once
//     (docs/ACTIVATION-FORENSICS-2026-09-18.md). false sets Checkout's
//     payment_method_collection to 'if_required' (only meaningful with an
//     active trial — with no trial the card is always required to charge
//     today's invoice).

const DEFAULT_TRIAL_DAYS = 14;

function resolveTrialDays(env) {
  const source = env || process.env;
  const raw = source.TRIAL_DAYS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_TRIAL_DAYS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TRIAL_DAYS;
  return n;
}

function resolveTrialRequireCard(env) {
  const source = env || process.env;
  return String(source.TRIAL_REQUIRE_CARD ?? 'true').trim().toLowerCase() !== 'false';
}

// Returns the fields to merge into a Stripe Checkout Session's
// `subscription_data` and top-level session params for the given trial
// config. Deliberately returns plain objects to merge, not a whole session,
// so callers keep full control of everything else.
function buildTrialSessionFields({ trialDays, requireCard }) {
  const subscriptionData = {};
  if (trialDays > 0) {
    subscriptionData.trial_period_days = trialDays;
  }
  const topLevel = {};
  if (trialDays > 0 && !requireCard) {
    topLevel.payment_method_collection = 'if_required';
  }
  return { subscriptionData, topLevel };
}

module.exports = {
  DEFAULT_TRIAL_DAYS,
  resolveTrialDays,
  resolveTrialRequireCard,
  buildTrialSessionFields,
};
