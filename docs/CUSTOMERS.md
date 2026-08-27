# Current Customers

**MRR: $204/month** (7 founding @ $29 + Suzanne @ $1 founding friend = 8 active). Corrected 2026-08-24 — Heath approved cancelling Miki Mccarthy and Amanda Nuckles (both real, paying $29/mo founders); Stripe subscriptions cancelled `cancel_at_period_end: true` (access continues through their already-paid period, no immediate cutoff — Miki through 2026-09-20, Amanda through 2026-09-20), `subscriptions` rows updated to match. Verified live against `subscriptions` table: 10 rows with `plan='founding'` and `status='active'` (2 of those 10 — Miki, Amanda — now `cancel_at_period_end=true`, excluded from this MRR count and the active roster below even though Stripe status won't flip to `canceled` until their period ends), 4 real customer cancellations total (Zelda, Jennifer, Miki, Amanda — a 5th cancelled row is Heath's own 2026-05-01 test account, not a customer), 1 `pending_onboarding` (approved, not yet paying, doesn't count toward the 8).

Update this file on every onboard or cancel. Static count in CLAUDE.md (Section 5 Founding spots) must stay in sync — corrected 2026-08-24 from "10 existing members" to "8 existing members" to match the cancellations above.

| # | Name | Email | Plan | Notes |
|---|---|---|---|---|
| 1 | Kimberly Herrera | — | $29/mo founding member | — |
| 2 | Tiffany Gill | — | $29/mo founding member | — |
| 3 | Brittney YBarbo | brittney@setxrealty.com | $29/mo founding | Broker, 80 tx/yr, SE TX. Via FB search "transaction coordinating in Texas". Control-freak → Week-5 `control_freak_agent` content. Team-tier upsell 60-90d. **Ask testimonial at 30d.** **2026-08-26 lifecycle audit:** no record found anywhere (this file, marketing content, Telegram/memory) that the 30-day testimonial ask was ever actually sent — she's ~14 weeks past signup (May cohort) with no marketing quote on file beyond her original discovery quote below. Overdue; needs a direct manual ask. Note: this is NOT covered by `cron-testimonial-request` — that cron asks agents to request *their clients'* Google/Zillow reviews after a closing, a completely different flow from asking Brittney for a testimonial about Dossie itself. No automated system does the latter. |
| 4 | Suzanne Page | k.suzanne.page@gmail.com | $1/mo founding friend (`FOUNDING_FRIEND`) | — |
| 5 | Miki Mccarthy | mikirgvrealtor@gmail.com | **CANCELLED 2026-08-24** (was $29/mo founding) | RGV/McAllen. 2026-05-20. My Real Estate Company. First RGV. Phone 9562499454, heard: Facebook group (Ginger Unger). Cancellation approved by Heath, processed via Stripe `cancel_at_period_end: true` — access continues through 2026-09-20 (already-paid period), then locks. `subscriptions` row confirmed live (`stripe_subscription_id` sub_1TZFU8L920SKTEEiipOzFeXm, `cancel_at_period_end=true`, `canceled_at` 2026-08-25T00:22:07Z). Founding is closed permanently — does not reopen a spot. |
| 6 | Cecilia Whitley | cecilia@sterlingassociatesre.com | $29/mo founding | Austin. 2026-05-20. Sterling and Associates. First Austin. Phone+heard_from TBD. |
| 7 | Terry Katz | michellesellshouston@gmail.com | $29/mo founding | Houston/Spring. 2026-05-20 via DIRECT STRIPE INVOICE — manual recovery (see project_stripe_webhook_gap.md). Brokerage/phone/heard_from TBD. |
| 8 | Amanda Nuckles | amanda@amandanuckles.com | **CANCELLED 2026-08-24** (was $29/mo founding) | Central TX. 2026-05-20. All City Real Estate. 5127340036. First to use new onboarding form. Heard: Facebook group (specific TBD). Cancellation approved by Heath, processed via Stripe `cancel_at_period_end: true` — access continues through 2026-09-20 (already-paid period), then locks. `subscriptions` row confirmed live (`stripe_subscription_id` sub_1TZJbQL920SKTEEiOz4fmAWH, `cancel_at_period_end=true`, `canceled_at` 2026-08-25T00:22:08Z). Founding is closed permanently — does not reopen a spot. |
| 9 | Zelda Cain | zelda@a2zrealestateconsultants.com | **CANCELLED 2026-08-04** (was $29/mo founding) | Houston. 2026-05-21. A2Z Real Estate Consultants LLC. (281) 813-6887. Heard: friend/colleague (possibly Terry, 2nd Houston). First word-of-mouth. Had been flagged past_due with no dunning process in place — see `no-dunning-process-failed-payments` memory; this may be that situation resolving into a churn rather than a fresh cancellation. Founding is closed permanently (2026-08-04) — her cancellation does NOT reopen a spot; if she comes back it would be at current Solo/Team pricing. |
| 10 | Natalie Megerson | natalie@localchoicegroup.com | $29/mo founding | SA+Austin+San Marcos multi-market. 2026-05-22 04:10 UTC. REAL Broker. 5125575549. Heard: Facebook. **HOT TEAM-tier LEAD** — DM'd same morning re "large team in San Marcos". First multi-seat opportunity. Founding is closed — pitch her team on current Team pricing ($349/mo, 3 seats, $79.99/seat up to 8), not founding. **2026-08-26 lifecycle audit:** no record of any follow-up since the original same-morning DM (~13 weeks stale). Needs an actual outbound expansion touch this week (Friday's cadence in `docs/WEEKLY-MARKETING-PLAN.md`) — flagging as overdue, not newly discovered. |
| 11 | Jennifer Beltrán | jenn.casamiateam@gmail.com | **CANCELLED 2026-08-05** (was $29/mo founding) | Casa Mia Real Estate LLC. 9568671723. Paid 2026-05-22 14:27 CDT, webhook never provisioned — manual 2026-05-24 after she messaged. **2ND webhook-gap** (after Terry). Password recovery sent 2026-05-24. Cancellation confirmed live in `subscriptions` (`canceled_at` 2026-08-05T20:29:29Z). Founding is closed permanently — does not reopen a spot. |
| 12 | Lisa Nilsson | lisanilssontx@gmail.com | $29/mo founding | Boerne/Hill Country SA. 2026-05-28. Premier Hill Country Properties. 210-288-4476. Heard: friend/colleague. Manually provisioned (3rd webhook-gap: Terry, Jennifer, Lisa). |

---

## BRITTNEY CONTEXT (customer #2 — most important early customer)

- Found via FB search "transaction coordinating in Texas". Broker, 80 tx/yr, Southeast Texas, buyer+seller sides.
- Pain: control freak who can't trust delegation → became the **Control** marketing pillar.
- Quote: *"the lack of systems I have in place isn't sustainable."*
- Team-tier upsell at 60-90d ($149/mo for her agents). Ask for 1-sentence testimonial at 30d.
- Her insight = Week-5 `control_freak_agent` content calendar entries.
- **Status as of 2026-08-26: testimonial ask still not confirmed done — see row 3 note above.**

---

## LIFECYCLE / ACTIVATION AUDIT LOG

Running log per `docs/WEEKLY-MARKETING-PLAN.md`'s Thursday cadence (audit one lifecycle stage each week, 4-week
rotation: welcome drip → 30-day check-in → 60-90d upsell → win-back) and Tuesday's activation-triage /
Monday's past-due check. First entry below — no rotation tracking existed before this.

### 2026-08-26 — first audit run
- **No prior audit history exists.** `docs/WEEKLY-MARKETING-PLAN.md` was written 2026-08-25 but this is the
  first time any of its daily cadence items have been actually checked against real state. No
  `docs/FUNNEL-TESTS.md` exists either — Wednesday's "ship one A/B test" has never been logged.
- **Automation that IS live:** `api/cron-activation-drip.js` (3-email activation nudge sequence + 14-21d
  referral ask) and `api/cron-testimonial-request.js` (post-closing client review request) are both
  registered in `vercel.json`'s `crons` array — `0 15 * * *` and `0 14 * * *` respectively — and running daily
  on Vercel's own schedule, not dependent on an external trigger.
- **Automation that is NOT confirmed live:** `api/cron-pierce-activation.js` (the daily Telegram summary of
  founding members inactive >7 days — the closest thing to an automated Tuesday activation-triage digest) is
  **absent from `vercel.json`'s `crons` array**. Its own header comment says it's meant to be triggered by an
  external cron-job.org registration "NOT in vercel.json — Vercel is at limit." No doc (`docs/TECH-DEBT.md`,
  `docs/ENV.md`) records that registration ever being completed. Working assumption: this alert is likely NOT
  firing, and Heath/Pierce are not getting the daily inactivity ping the plan's Tuesday task assumes exists.
- **Cohort reality check:** all 8 active customers signed up in a tight window, 2026-05-20 through 2026-05-28
  — as of this audit that's ~90-97 days old. Every active account is already past the 60-90d upsell stage;
  none are in fresh welcome-drip or 30-day territory, so this week's "which stage is due" rotation question is
  somewhat moot for a static, aging cohort with no new signups since Lisa Nilsson (2026-05-28). The two
  concrete upsell/expansion items the plan itself calls out — Brittney's testimonial ask, Natalie's team-tier
  follow-up — both show no recorded action since their original flags (see rows 3 and 10 above).
- **Could not verify this session:** live `subscriptions` status changes (new/past_due/cancelled),
  `profiles.activation_email_*_sent_at` / `referral_ask_sent_at` columns (proof the drip actually fired for a
  given customer), or `transactions.testimonial_requested_at`. This dispatch's toolset had no Bash/shell, no
  direct Supabase/DB access, and no Heath-authenticated session token for `api/admin-billing-pulse.js` (which
  requires a live Supabase Bearer token for `heath.shepard@kw.com`, not `CRON_SECRET`). Next session with
  Bash access should either curl a `CRON_SECRET`-gated admin endpoint or check the live dashboard directly
  rather than re-guessing from this file.

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
