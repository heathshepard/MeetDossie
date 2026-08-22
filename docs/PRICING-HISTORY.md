# Pricing History

Current pricing lives in CLAUDE.md Section 5. This file = history + rationale only.

---

## 2026-05-15 — Solo $49→$79, Team $149→$199, seats $25→$35

**Rationale:** Market research showed DealDock ($79), ListedKit ($49+), Done Deal (unpublished) all charged more for less Texas-specific value. New pricing reflects market positioning.

**Locked in:** Founding members at $29/mo forever — non-negotiable.

---

## Add-on prices (current)

- Email Integration — $15/mo, $7.50/mo for founding members (exactly 50% off per Terms of Service §4.2). Live 2026-08-22 (renamed + expanded from "Reply Monitoring" — bundles deal-email filing, e-sign completion detection, and ShowingTime feedback ingestion under one entitlement flag). Stripe price `price_1U7FeAL920SKTEEidpJB0D0Z`, founding coupon `founding-addon-50off`.
- AI Autopilot — $15/mo
- Compliance Vault — $10/mo
- White Label — $200-500/mo
- Scans — 5 free, then $1.50 each
- E-sig — 10 free, then $0.50 each
- Onboarding — $99 one-time

---

## 2026-08-22 — "Reply Monitoring" renamed to "Email Integration", $10/mo → $15/mo

**What changed:** The $10/mo "Reply Monitoring" add-on (deal-email flagging only) became "Email Integration" at $15/mo, now bundling three capabilities: (1) deal-email filing — the original capability, (2) e-sign completion detection, (3) ShowingTime feedback ingestion (feeds a separate weekly listing-performance digest). One email connection, one entitlement flag (`subscriptions.email_integration_enabled`, renamed from `reply_monitoring_enabled`).

**Founding discount:** 50% off ($7.50/mo) per Terms of Service §4.2 — chosen deliberately as a straight 50%-off structure (not a reversed discount Heath first floated) to stay inside the existing binding ToS clause.

**Backend:** api/cron-email-to-dossier.js and api/cron-esign-events.js went genuinely multi-tenant (previously hardcoded to Heath's own mailbox / ungated respectively). api/cron-showingtime-feedback.js is net new. Self-serve checkout is scoped to this one add-on only (api/create-addon-checkout-session.js) — does NOT require or touch base-plan (Solo/Team) Stripe pricing, which still has no live price IDs.

---

## Founding pricing notes

- 50 founding spots total
- Locked $29/mo for life — never change
- Founding members get 50% off any add-ons forever
- `FOUNDING_FRIEND` coupon = $1/mo (used once for Suzanne Page)
- `FOUNDING` coupon does NOT exist in Stripe — causes errors if referenced; default flow uses `noCoupon`
