-- "Compliance Vault" paid add-on for Solo agents (2026-08-24, Heath via
-- Cole) — the same document present/missing view just shipped for Team
-- (api/team/org-documents.js), scoped to a single solo agent's own
-- transactions instead of an org roster. Exact same shape as the Email
-- Integration add-on (20260822_email_integration_addon.sql): one entitlement
-- boolean + one Stripe-subscription-id column, self-serve checkout/cancel.
--
-- Pricing: $15/mo full price, $7.50/mo (exactly 50% off) for founding
-- members per Terms of Service §4.2 — same price point and same founding
-- coupon (`founding-addon-50off`, confirmed generic/reusable — not tied to
-- any specific Stripe price) as Email Integration. See docs/PRICING-HISTORY.md.

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS compliance_vault_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN subscriptions.compliance_vault_enabled IS
  'Compliance Vault add-on ($15/mo, $7.50/mo founding) entitlement for Solo agents. Gates api/solo-documents.js (the personal document present/missing search view). Set by api/stripe-webhook.js on the add-on Stripe subscription (see api/create-compliance-vault-checkout-session.js) or by hand via admin-stripe-tools.';

-- Tracks the add-on's OWN Stripe subscription id, separate from the base-plan
-- stripe_subscription_id AND from email_integration_stripe_sub_id on the same
-- row (a customer can stack multiple add-on subscriptions on one customer).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS compliance_vault_stripe_sub_id TEXT;

COMMENT ON COLUMN subscriptions.compliance_vault_stripe_sub_id IS
  'Stripe subscription id for the Compliance Vault add-on specifically. NULL when the add-on was enabled by hand rather than through checkout.';
