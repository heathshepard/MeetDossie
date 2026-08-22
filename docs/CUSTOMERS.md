# Current Customers

**MRR: $262/month** (9 founding @ $29 + Suzanne @ $1 founding friend = 10 active). Corrected 2026-08-22 — Jennifer Beltrán's 2026-08-05 cancellation had never been reflected here (Zelda Cain's 2026-08-04 cancellation already was). Verified live against `subscriptions` table: 10 rows with `plan='founding'` and `status='active'`, 2 real customer cancellations (Zelda, Jennifer — a 3rd cancelled row is Heath's own 2026-05-01 test account, not a customer), 1 `pending_onboarding` (approved, not yet paying, doesn't count toward the 10).

Update this file on every onboard or cancel. Static count in CLAUDE.md (Section 5 Founding spots) must stay in sync — as of 2026-08-22 both already say 10 members, closed 2026-08-04.

| # | Name | Email | Plan | Notes |
|---|---|---|---|---|
| 1 | Kimberly Herrera | — | $29/mo founding member | — |
| 2 | Tiffany Gill | — | $29/mo founding member | — |
| 3 | Brittney YBarbo | brittney@setxrealty.com | $29/mo founding | Broker, 80 tx/yr, SE TX. Via FB search "transaction coordinating in Texas". Control-freak → Week-5 `control_freak_agent` content. Team-tier upsell 60-90d. **Ask testimonial at 30d.** |
| 4 | Suzanne Page | k.suzanne.page@gmail.com | $1/mo founding friend (`FOUNDING_FRIEND`) | — |
| 5 | Miki Mccarthy | mikirgvrealtor@gmail.com | $29/mo founding | RGV/McAllen. 2026-05-20. My Real Estate Company. First RGV. Phone+heard_from TBD. |
| 6 | Cecilia Whitley | cecilia@sterlingassociatesre.com | $29/mo founding | Austin. 2026-05-20. Sterling and Associates. First Austin. Phone+heard_from TBD. |
| 7 | Terry Katz | michellesellshouston@gmail.com | $29/mo founding | Houston/Spring. 2026-05-20 via DIRECT STRIPE INVOICE — manual recovery (see project_stripe_webhook_gap.md). Brokerage/phone/heard_from TBD. |
| 8 | Amanda Nuckles | amanda@amandanuckles.com | $29/mo founding | Central TX. 2026-05-20. All City Real Estate. 5127340036. First to use new onboarding form. Heard: Facebook group (specific TBD). |
| 9 | Zelda Cain | zelda@a2zrealestateconsultants.com | **CANCELLED 2026-08-04** (was $29/mo founding) | Houston. 2026-05-21. A2Z Real Estate Consultants LLC. (281) 813-6887. Heard: friend/colleague (possibly Terry, 2nd Houston). First word-of-mouth. Had been flagged past_due with no dunning process in place — see `no-dunning-process-failed-payments` memory; this may be that situation resolving into a churn rather than a fresh cancellation. Founding is closed permanently (2026-08-04) — her cancellation does NOT reopen a spot; if she comes back it would be at current Solo/Team pricing. |
| 10 | Natalie Megerson | natalie@localchoicegroup.com | $29/mo founding | SA+Austin+San Marcos multi-market. 2026-05-22 04:10 UTC. REAL Broker. 5125575549. Heard: Facebook. **HOT TEAM-tier LEAD** — DM'd same morning re "large team in San Marcos". First multi-seat opportunity. Founding is closed — pitch her team on current Team pricing ($349/mo, 3 seats, $35/seat up to 8), not founding. |
| 11 | Jennifer Beltrán | jenn.casamiateam@gmail.com | **CANCELLED 2026-08-05** (was $29/mo founding) | Casa Mia Real Estate LLC. 9568671723. Paid 2026-05-22 14:27 CDT, webhook never provisioned — manual 2026-05-24 after she messaged. **2ND webhook-gap** (after Terry). Password recovery sent 2026-05-24. Cancellation confirmed live in `subscriptions` (`canceled_at` 2026-08-05T20:29:29Z). Founding is closed permanently — does not reopen a spot. |
| 12 | Lisa Nilsson | lisanilssontx@gmail.com | $29/mo founding | Boerne/Hill Country SA. 2026-05-28. Premier Hill Country Properties. 210-288-4476. Heard: friend/colleague. Manually provisioned (3rd webhook-gap: Terry, Jennifer, Lisa). |

---

## BRITTNEY CONTEXT (customer #2 — most important early customer)

- Found via FB search "transaction coordinating in Texas". Broker, 80 tx/yr, Southeast Texas, buyer+seller sides.
- Pain: control freak who can't trust delegation → became the **Control** marketing pillar.
- Quote: *"the lack of systems I have in place isn't sustainable."*
- Team-tier upsell at 60-90d ($149/mo for her agents). Ask for 1-sentence testimonial at 30d.
- Her insight = Week-5 `control_freak_agent` content calendar entries.

---

## DEMO ACCOUNTS — LOCKED. DO NOT CHANGE.

| Email | Password (env var) | Profile Name | Personas | Voice |
|---|---|---|---|---|
| `demo@meetdossie.com` | `DEMO_PASSWORD` = `DEMO_PASSWORD` in Vercel env | Sarah Whitley | brenda, patricia | Luna |
| `demo2@meetdossie.com` | `DEMO2_PASSWORD` = `DEMO2_PASSWORD` in Vercel env | John Smith | victor | Bill |

Both seeded with 6 transactions, 25 documents, 20 action items.

## PERSONA → DEMO ACCOUNT MAPPING — LOCKED

| Persona | Demo account | Voice |
|---|---|---|
| brenda | Sarah Whitley / `demo@meetdossie.com` | Luna |
| patricia | Sarah Whitley / `demo@meetdossie.com` | Luna |
| victor | John Smith / `demo2@meetdossie.com` | Bill |
