-- Free trial rollout (2026-09-26, Heath via Cole) — 14-day card-required
-- trial on Solo/Team checkout (api/create-checkout-session.js's TRIAL_DAYS).
--
-- subscriptions.status already gained a 'trialing' value in practice (Stripe
-- reports it, api/stripe-webhook.js now stores it as its own status instead
-- of folding it into 'active') but there was nowhere to persist WHEN a trial
-- started/ends, which api/cron-trial-conversion-watch.js needs to tell "still
-- mid-trial" apart from "trial ended without converting" without an extra
-- Stripe round-trip per row.

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_start TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_end TIMESTAMPTZ;

COMMENT ON COLUMN subscriptions.trial_start IS
  'Stripe subscription.trial_start, mirrored on checkout.session.completed / customer.subscription.created / customer.subscription.updated / complete-onboarding. NULL for subscriptions created with no trial (TRIAL_DAYS=0) or before this column existed.';

COMMENT ON COLUMN subscriptions.trial_end IS
  'Stripe subscription.trial_end, mirrored the same way as trial_start. Used by api/cron-trial-conversion-watch.js to distinguish a trial that has not ended yet from one that ended without converting to active.';
