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

**Backend:** api/cron-email-to-dossier.js and api/cron-esign-events.js went genuinely multi-tenant (previously hardcoded to Heath's own mailbox / ungated respectively). api/cron-showingtime-feedback.js is net new. Self-serve checkout is scoped to this one add-on only (api/create-addon-checkout-session.js) — does NOT require or touch base-plan (Solo/Team) Stripe pricing.

---

## 2026-08-22 — Solo/Team live self-serve checkout wired (base plans had NO paid path for ~1 week+)

**What was broken:** `api/create-checkout-session.js` had returned a hardcoded 410 since the 2026-08-13 founding-closure sweep — Solo ($149/mo) and Team ($349/mo) had no live Stripe price IDs, so a real prospect choosing either plan had no way to pay. `api/signup.js` only offered invite-code (comped) or request-access (manual Telegram approval) paths.

**What changed:**
- Created 4 live Stripe prices via `/api/admin-stripe-tools` (`create_price`): Solo monthly `price_1U7SiPL920SKTEEiZh5WgMMh` ($149/mo), Solo annual `price_1U7Sj8L920SKTEEiGgS84T8E` ($468/yr, displayed as "$39/mo billed annually"), Team monthly `price_1U7SiQL920SKTEEiE4MxCWKK` ($349/mo), Team annual `price_1U7Sj9L920SKTEEiBWCR51M7` ($1,428/yr, displayed as "$119/mo billed annually"). IDs live in Vercel env as `STRIPE_PRICE_SOLO_MONTHLY` / `STRIPE_PRICE_SOLO_ANNUAL` / `STRIPE_PRICE_TEAM_MONTHLY` / `STRIPE_PRICE_TEAM_ANNUAL` (Prod+Preview).
  **⚠️ SUPERSEDED 2026-08-23** — the two annual price IDs above (`price_1U7Sj8L920SKTEEiGgS84T8E`, `price_1U7Sj9L920SKTEEiBWCR51M7`) were deactivated the next day; Heath rejected the $39/$119-derived annual totals. See the 2026-08-23 entry below for the real numbers and the replacement price IDs now live in `STRIPE_PRICE_SOLO_ANNUAL` / `STRIPE_PRICE_TEAM_ANNUAL`.
- **Annual billing = one charge per year**, not a discounted monthly-recurring charge. Two prices were first created with the wrong interval (monthly recurring at the $39/$119 rate) and had to be deactivated via the new `deactivate_price` admin-stripe-tools action — the "$X/mo billed annually" marketing copy is a monthly-equivalent display of the annual total.
- `api/create-checkout-session.js` rebuilt to sell these 4 prices (mode=subscription), following the original founding-checkout CORS/rate-limit pattern. Founding stays closed.
- `api/_lib/pricing-tiers.js` is now the single price-ID→plan map, used by the webhook, checkout, and onboarding endpoints. Fixed a real bug found in the process: `api/complete-onboarding.js` was hardcoding every paying customer's plan to `'founding'` and sending them a welcome email claiming a locked $29/mo rate, regardless of what they actually bought — would have mis-tagged every Solo/Team signup and sent a false pricing promise.
- `signup.html` now has a Solo/Team plan card (monthly/annual toggle) that posts to create-checkout-session and redirects to Stripe. Invite-code/request-access paths unchanged.

**Team seat overage** ($35/seat above the 3 included, up to 8) is handled by the existing org/seat billing system (`api/team/billing.js`, `api/team/create-org.js`) — not touched by this change. `api/team/create-org.js` still defaults `seat_price_cents` to 7900 (the old $79 Solo rate) rather than 3500 — flagged, not fixed, out of scope for this pass.

---

## 2026-08-23 — Annual pricing corrected to a real 15% discount (previous day's $39/$119-derived totals were wrong)

**What happened:** The 2026-08-22 annual prices ($468/yr Solo, $1,428/yr Team) were built by taking the old, unrelated "$39/mo" / "$119/mo" marketing figures and annualizing them (x12) — those figures predate the 2026-07-31 Solo/Team price increase and were never re-derived from the new $149/$349 monthly rates. Heath's explicit correction, his words: **"no absolutely not make the yearly savings 15%."**

**Correct math — 15% off the annualized monthly rate:**
- Solo: $149/mo × 12 = $1,788/yr annualized → 15% off = **$1,519.80/yr** ($126.65/mo equivalent)
- Team: $349/mo × 12 = $4,188/yr annualized → 15% off = **$3,559.80/yr** ($296.65/mo equivalent)

**What changed:**
- Deactivated the two wrong annual prices (`price_1U7Sj8L920SKTEEiGgS84T8E`, `price_1U7Sj9L920SKTEEiBWCR51M7`) via `deactivate_price`.
- Created two new live annual prices: Solo `price_1U7aP3L920SKTEEiwG31Ms29` ($1,519.80/yr), Team `price_1U7aP4L920SKTEEil0IuIkxm` ($3,559.80/yr). Same product objects (`prod_UOkpCJiDvbsf7a` Solo, `prod_UOkp2gkTYP2N4O` Team) as the monthly prices.
- Updated `STRIPE_PRICE_SOLO_ANNUAL` / `STRIPE_PRICE_TEAM_ANNUAL` in Vercel (Prod+Preview) to the new price IDs — `api/_lib/pricing-tiers.js` and everything downstream (checkout, webhook, onboarding) picks these up automatically since nothing else hardcodes the price ID.
- `signup.html`'s Annual toggle display updated: "$126.65/mo billed annually ($1,519.80/yr)" for Solo, "$296.65/mo billed annually ($3,559.80/yr)" for Team. Toggle badge changed from "(save 2 months+)" to "(save 15%)".
- CLAUDE.md Section 5 Annual column updated to the real totals with the 15%-off math spelled out.

---

## Founding pricing notes

- 50 founding spots total
- Locked $29/mo for life — never change
- Founding members get 50% off any add-ons forever
- `FOUNDING_FRIEND` coupon = $1/mo (used once for Suzanne Page)
- `FOUNDING` coupon does NOT exist in Stripe — causes errors if referenced; default flow uses `noCoupon`
