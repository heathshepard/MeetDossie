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

**Team seat overage** (then $35/seat above the 3 included, up to 8 — see the 2026-08-23 entries below for the full history of this figure, now $79.99/seat) is handled by the existing org/seat billing system (`api/team/billing.js`, `api/team/create-org.js`) — not touched by this change. `api/team/create-org.js` at the time still defaulted `seat_price_cents` to 7900 (the old $79 Solo rate) rather than 3500 — flagged, not fixed, out of scope for this pass. Fixed the same day; see below.

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

## 2026-08-23 — Team seat overage: $79/seat bug fixed to $35/seat, then Heath's considered decision raised it to $79.99/seat

**Part 1 — bug fix.** `api/team/create-org.js` and `api/_lib/team-org.js` had hardcoded `p_seat_price_cents: 7900` — a stray $79 (the old Solo rate) never corrected when the real Team seat-overage price ($35, see the 2026-05-15 entry above) was set. `api/team/billing.js` also fell back to the same wrong 7900 when an org's `seat_price_cents` was unset, and separately was multiplying the per-seat price by *every* paid seat with no 3-seat subtraction — a second, independent bug. Both fixed same-day: seat price corrected to 3500 ($35/seat) everywhere it appeared, `billing.js`'s overage math corrected to `max(0, paid_seats - 3) * seat_price_cents`. Also built, same session: a hard 8-seat cap (nothing enforced the max before) and real Stripe billing sync — a subscription item on the team lead's existing Team subscription, quantity = seats beyond the 3 included, kept in sync on invite/remove/role-change via `api/_lib/team-seat-billing.js`. Stripe price `price_1U7fH9L920SKTEEifvTGxkrO` created at $35/mo for this.

**Part 2 — Heath's pricing decision, same day, right after Part 1 landed on staging.** Raised the extra-seat price from $35/mo to **$79.99/mo**. This is a considered pricing call, not a bug fix — still well under both the $149 Solo standalone price and the $400/file value comparison Dossie is sold against. Since no real Team subscription has ever existed (confirmed directly against the DB before this change), there was no paying customer to grandfather — clean cutover, unlike the Solo/Team base-price increase (`existing subs unaffected` carve-out on 2026-07-31) which had real subscribers to protect.

**What changed:**
- Deactivated the $35/mo price (`price_1U7fH9L920SKTEEifvTGxkrO`, never used by a real subscription) via `deactivate_price`.
- Created a new live price on the same product (`prod_V7v7HDeXudL03W`, "Dossie Team — Extra Seat"): `price_1U7fS6L920SKTEEix5vP4FVd` at $79.99/mo.
- Updated `STRIPE_PRICE_TEAM_EXTRA_SEAT` in Vercel (Prod+Preview) to the new price ID.
- Updated every hardcoded `3500`/`"$35/seat"` reference: `api/team/create-org.js`, `api/_lib/team-org.js`, `api/_lib/team-seat-count.js` (now the single seat-pricing source of truth), the two seat-cap error messages (`team-invite-core.js`, `update-roles.js` — made these compute the dollar figure from `seat_price_cents` instead of a hardcoded string, so a future price change doesn't require finding these again), `signup.html`'s Team plan-note copy, and the pricing-context strings in `api/cron-generate-posts.js`, `api/jarvis-context-load.js`, `api/mcp.js`, `api/_lib/sage-verified-facts.js`, `docs/CUSTOMERS.md` (Natalie Megerson lead note).
- New migration correcting the `create_org_with_founder` RPC's SQL default a second time (7900 → 3500 → 7999) — added as a new migration rather than editing the 3500 one, since migration history should read forward, not be rewritten, even though (as of this writing) no migration in this chain has actually been applied to the live DB yet (no DB credential available in the agent session that built this — flagged separately, not a pricing question).
- CLAUDE.md Section 5 Team row updated: "max 8 at $79.99/seat".
- Re-verified via `preview_invoice` (non-committal, no real subscription created) that the new rate flows through correctly: base $349.00, +1 extra seat $428.99, ..., 5-seat/8-total cap $748.95 ($349 + 5×$79.99). Exact figures logged in the session that made this change.

---

## Founding pricing notes

- 50 founding spots total
- Locked $29/mo for life — never change
- Founding members get 50% off any add-ons forever
- `FOUNDING_FRIEND` coupon = $1/mo (used once for Suzanne Page)
- `FOUNDING` coupon does NOT exist in Stripe — causes errors if referenced; default flow uses `noCoupon`
