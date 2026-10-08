'use strict';

// api/_lib/subscription-status-map.js
//
// Maps a Stripe Subscription `status` to our own subscriptions.status /
// profiles.subscription_status vocabulary. Pulled out of
// api/stripe-webhook.js's handleSubscriptionUpdated (2026-09-26, free-trial
// rollout) so the mapping — including the 'trialing' branch that used to be
// entirely unreachable for Solo/Team because of a price-ID guard bug — is
// unit-testable without mocking the Stripe SDK. See
// api/stripe-webhook.test.js.
//
// 'trialing' is intentionally its OWN status, never folded into 'active'.
// The customer already has full product access during a trial (that's
// handled by /api/complete-onboarding's credential delivery, which has never
// been gated on this field) — but subscriptions.status='trialing' is what
// lets cron-account-invite-autoresend / cron-pierce-activation / this file's
// sibling cron-trial-conversion-watch tell "mid-trial, on track" apart from
// "converted" or "trial failed to convert".
function mapStripeSubscriptionStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
      return 'past_due';
    case 'unpaid':
      // Treat unpaid the same as past_due — no separate downstream behavior
      // distinguishes them today.
      return 'past_due';
    case 'canceled':
      return 'cancelled'; // British spelling — matches the rest of this DB's column values.
    default:
      // incomplete / incomplete_expired / paused / unknown-future-value —
      // pass through raw rather than guessing. Callers should treat an
      // unrecognized value as worth logging, not silently coercing.
      return stripeStatus;
  }
}

module.exports = { mapStripeSubscriptionStatus };
