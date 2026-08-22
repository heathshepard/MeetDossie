-- "Email Integration" paid add-on (renamed + expanded from "Reply Monitoring"
-- 2026-08-22, Heath via Cole). Bundles three inbox-watching capabilities under
-- one email connection + one entitlement flag:
--   1. Deal-related email flagging/filing (api/cron-email-to-dossier.js)
--   2. E-sign completion detection (api/cron-esign-events.js)
--   3. ShowingTime feedback ingestion (api/cron-showingtime-feedback.js)
--
-- subscriptions.reply_monitoring_enabled already exists live (confirmed via
-- REST query 2026-08-22 — the 20260812 migration's "not yet applied" comment
-- is stale; it was applied at some point after that session). This migration
-- renames it in place rather than adding a parallel column, since nothing in
-- the live app reads the old name yet (the only UI reference was a disabled
-- placeholder checkbox with no backend wiring).
--
-- Pricing: $15/mo full price, $7.50/mo (exactly 50% off) for founding members
-- per Terms of Service §4.2. See docs/PRICING-HISTORY.md.

ALTER TABLE subscriptions RENAME COLUMN reply_monitoring_enabled TO email_integration_enabled;

COMMENT ON COLUMN subscriptions.email_integration_enabled IS
  'Email Integration add-on ($15/mo, $7.50/mo founding) entitlement. Gates api/cron-email-to-dossier.js, api/cron-esign-events.js, api/cron-showingtime-feedback.js. Set by api/stripe-webhook.js on the add-on Stripe subscription (see api/create-addon-checkout-session.js) or by hand via admin-stripe-tools.';

-- Tracks the add-on's OWN Stripe subscription id, separate from the base-plan
-- stripe_subscription_id column on the same row (a customer can have a base
-- plan sub AND an add-on sub, billed as two line items on one customer).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS email_integration_stripe_sub_id TEXT;

COMMENT ON COLUMN subscriptions.email_integration_stripe_sub_id IS
  'Stripe subscription id for the Email Integration add-on specifically (distinct from the base-plan stripe_subscription_id on this same row). NULL when the add-on was enabled by hand rather than through checkout.';
