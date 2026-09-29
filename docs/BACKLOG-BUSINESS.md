# BACKLOG — Business, Marketing, Go-to-Market

Built 2026-09-17. Scope: marketing/content engine, Dossie GTM, Heath's real estate
business, Rust launch, business admin. **Engineering, product code, crons and the
agent queue are deliberately excluded** — a separate inventory covers those.

**90 items.** **22 an agent can complete with no input from Heath.** 43 need Heath
personally. 23 are mixed — an agent does the work and stops at one gate (a click, a
send approval, a forwarded letter). 2 are correctly parked behind a named trigger.

By area: marketing/content engine 14 · Dossie GTM 11 · real estate 24 · Rust launch 20 ·
business admin 21.

## How to read this

- **Blocked by** decides what an automated loop may pull. `agent` means genuinely
  unattended. `Heath` means a credential, a payment, a signature, a phone call, a
  human relationship, or a judgment call only he can make. `mixed` means an agent
  does the work and stops at one gate.
- **Confidence** is either `verified 2026-09-17` (checked against live data or disk
  today) or `inherited` (comes from a memory file that could not be re-checked).
  Treat `inherited` as a lead, not a fact.
- Items are ranked within each area by impact per effort.
- Section 7 lists records that are **provably wrong today**. Fix those first or they
  will keep generating wrong work.

---

## TOP 5 ACROSS EVERYTHING

| # | Item | Why it's here | Blocked by |
|---|---|---|---|
| 1 | **Stripe webhook isn't subscribed to `customer.subscription.updated` / `invoice.payment_failed`** (G2) | ~10 minutes of checkbox work in the Stripe dashboard. It is the reason nobody knows whether the 8 "active" customers are still paying, and the reason the dunning code that already exists has never once run. Best impact-per-effort item in the whole document. | Heath (Stripe dashboard) |
| 2 | **5 of 8 paying customers have never used the product** (G1) | Kimberly Herrera, Cecilia Whitley, Terry Katz, Natalie Megerson and Lisa Nilsson have every `onboarding_progress` flag false, ~4 months after signing up. This is $145/mo of the $204 MRR sitting on accounts that have never opened a dossier. It is the whole churn story. | mixed |
| 3 | **702 Fawndale mortgagee must change to Fay Servicing, effective 2026-10-06** (BA4) | 19 days out. The identical failure — policy naming the wrong servicer — already produced force-placed insurance on this exact property once. | Heath |
| 4 | **702 Fawndale security-deposit disposition, statutory deadline ~2026-10-10** (BA5) | 23 days out. Tex. Prop. Code §92.109 exposure is 3× the deposit + $100 + tenant's attorney fees. **No todo anywhere tracks it** — verified against `jarvis_todos` today. | mixed |
| 5 | **713/715 Homer Ave S (FL duplex) has zero liability coverage** (BA7) | Quoted 2024-12-05, never bound. 21 months open. A tenant or guest injury is an uncapped personal-asset claim, and an umbrella cannot fix it because there is no underlying limit to sit above. | Heath |

**Best unattended quick win:** RM13 — four fabricated claims still live in
`marketing/rust-hook-library.md`. 15 minutes, replacement text already written,
no dependencies, and it is a false-advertising risk on a health app.

---

## 1. MARKETING / CONTENT ENGINE

**The headline correction: the content engine is NOT shut down.** Memory
`content-engine-shutdown-2026-07-12.md` says three kill switches are engaged. All
three are off. `posting_schedule` has 49 rows with `is_active = true` across every
platform; Facebook, LinkedIn and Twitter all posted **today, 2026-09-17**. That
memory file is stale and should be rewritten.

What is actually wrong is different and more specific: **three of six platforms are
dead, the alarm layer correctly reports it every single day, and nothing acts on
the alarms.**

### M1 — Heath's personal LinkedIn has failed 20 consecutive times and has never once succeeded
- **What.** The `linkedin_personal` publisher has failed on every attempt from
  2026-08-15 through 2026-09-14. Zero posts have ever succeeded. 4 approved posts sit queued.
- **Evidence.** `social_posts` where `platform='linkedin_personal'`: 20 `failed`, 4
  `approved`, 0 `posted`. Every error is the same Playwright timeout —
  `waiting for getByRole('button', { name: 'Post', exact: true })`. `alert_state`
  key `linkedin_login_required` fired **2026-09-17**, plus 17 distinct
  `linkedin_publish_dead_letter:*` keys.
- **Impact.** LinkedIn is the only platform producing real reach (39,342 impressions
  vs Facebook's 5,374). Heath's personal profile — the one with actual professional
  network value — has published nothing in a month.
- **Effort.** Small if it's just a session re-auth. Medium if the selector broke.
- **Blocked by.** mixed — the alarm names the cause (logged out). Check Bitwarden for
  the credential first; a 2FA challenge would make it Heath's.
- **Confidence.** verified 2026-09-17.

### M2 — 628 leads harvested into `warm_touch_queue`, zero ever engaged
- **What.** A lead queue that has been filling since 2026-08-11 and has never drained once.
- **Evidence.** `select count(*), count(engaged_at) from warm_touch_queue` → 628
  rows, **0** with `engaged_at` set. 625 still `pending`. Rows were still being
  added today.
- **Impact.** 628 identified prospects, five weeks of collection, zero touches. This
  is the same "queue fills but never drains" pattern the cold-email memory was
  originally (wrongly) about — except here it is literally true.
- **Effort.** Small to diagnose why nothing consumes it; medium to actually run
  outreach.
- **Blocked by.** agent (to diagnose and report). The outreach itself needs a policy
  decision from Heath given the cold-email history.
- **Confidence.** verified 2026-09-17.

### M3 — 89 verbatim agent pain quotes harvested, none classified
- **What.** The TC discovery campaign collected 89 real responses. Every
  classification column is null on every row.
- **Evidence.** `tc_discovery_responses`: 89 rows, `count(theme)=0`,
  `count(pain_category)=0`. Table comment: *"comment_text is VERBATIM agent language
  for landing copy — never normalize... Classification columns stay NULL until review."*
- **Impact.** The entire point of the campaign was real language for landing copy,
  the same pattern as `reddit_pain_language`. The raw material was gathered and then
  never turned into anything.
- **Effort.** Small — one classification pass.
- **Blocked by.** **agent.**
- **Confidence.** verified 2026-09-17.

### M4 — Instagram silent 5 days, TikTok effectively never launched, YouTube never launched
- **What.** Instagram last posted 2026-09-12 with 2 posts stuck in `pending_video`.
  TikTok has **1 successful post in its entire history** (2026-08-18) against 17
  failures, with 1 approved and 1 `pending_video` stuck now. YouTube has an active
  7-day schedule and **has never posted at all**.
- **Evidence.** `social_posts` grouped by platform/status. `alert_state` keys
  `silence:instagram:dossie`, `silence:tiktok:dossie`, `silence:youtube:dossie` all
  fired **2026-09-17**; `backlog:instagram:pending_video`,
  `backlog:tiktok:pending_video` fired 2026-09-16. Blocking error on the Instagram
  rows: *"instagram row has no media_url — video-first policy holds until a video is
  attached."*
- **Impact.** Three of six platforms produce nothing. Under the video-only policy
  (`feedback_video-only-no-static-cards`) the render pipeline is the single
  dependency for half the distribution surface.
- **Effort.** Medium — this is a render-pipeline problem, not a posting problem.
- **Blocked by.** agent (the render side). Note the video approval gate below.
- **Confidence.** verified 2026-09-17.

### M5 — 9 videos have sat awaiting approval for 25 days
- **What.** `video_library` holds 9 rows at `pending_approval`, newest 2026-08-23.
- **Evidence.** `video_library` status counts; `alert_state` key
  `video_library_pending_review` fired 2026-09-12.
- **Impact.** Directly feeds M4 — the Instagram/TikTok backlog is starved while
  finished videos wait on a review nobody does.
- **Effort.** Small.
- **Blocked by.** Heath (approval).
- **Confidence.** verified 2026-09-17.

### M6 — 41 group posts sit unposted, 26 of them three months old
- **What.** `group_posts` holds 26 drafts created 2026-06-15/17 that were never
  approved or rejected, plus 15 more drafts from 2026-09-11 to 09-17, plus 2
  approved posts that never went out (TEXAS REAL ESTATE 09-10, TC group 09-16).
- **Evidence.** `group_posts` grouped by group/status. `alert_state` keys
  `drafts_stale:group_posts` (09-16) and `approvals_stale:group_posts` (09-17).
- **Impact.** The June drafts reference founding pricing that closed 2026-08-04 —
  they cannot ship as written and are pure noise in the approval queue.
- **Effort.** Small — purge the stale cohort, work the current one.
- **Blocked by.** agent for the purge; Heath for approvals.
- **Confidence.** verified 2026-09-17.

### M7 — The Founding Files FB group is abandoned, and Heath isn't a member of it
- **What.** Heath's own group. One approved post has sat unposted since 2026-08-17.
  The only other post attempt in its history was `identity_rejected` on 2026-06-09.
- **Evidence.** `group_posts` where `group_name ilike '%founding%'` → 2 rows total.
  `docs/TC-DISCOVERY-CAMPAIGN.md`, from a rendered logged-in browser read on
  2026-09-06: the group has **5 members**, FB reports *"No posts in the last month"*,
  and **Heath's personal profile renders a "Join group" button on his own group.**
- **Impact.** CLAUDE.md RULE 4 treats this as the autonomous posting channel. It is
  a dead 5-member group that its owner hasn't joined.
- **Effort.** Small to join; the channel's value is a separate judgment call.
- **Blocked by.** Heath (his personal FB account).
- **Confidence.** verified 2026-09-17 (group_posts); group state inherited from a
  2026-09-06 verified browser read.

### M8 — Comment and engagement pipelines have approved work that never posted
- **What.** 2 `comment_opportunities` approved and not posted; 3 at `post_failed`
  (terminal by design, never retried); 4 `engagement_queue` rows approved and not
  posted since 2026-09-08.
- **Evidence.** status counts on both tables.
- **Impact.** Heath approved these in Telegram. Approval is the expensive step and it
  was spent for nothing.
- **Effort.** Small.
- **Blocked by.** agent.
- **Confidence.** verified 2026-09-17.

### M9 — The nightly content pipeline died 2026-08-13
- **What.** `content_pipeline_queue` (the guide/answer/feature page generator in
  `docs/CONTENT-PIPELINE.md`) has had no activity in 35 days. 6 rows stuck at
  `researching`, 4 `failed`, 21 `promoted`.
- **Evidence.** `max(created_at)` = 2026-08-13 across all statuses.
- **Impact.** SEO page generation — the only non-social organic channel — stopped
  silently and nothing alarmed on it.
- **Effort.** Medium.
- **Blocked by.** agent.
- **Confidence.** verified 2026-09-17.

### M10 — Analytics are blind on three of six platforms
- **What.** `post_analytics` covers Facebook, LinkedIn and Instagram only. Twitter
  has 110 published posts and zero analytics rows. TikTok and YouTube likewise.
- **Evidence.** `post_analytics` grouped by platform → 3 platforms, 2,439 rows,
  last sync 2026-09-13.
- **Impact.** Sage's weekly hook/CTA review runs on a partial dataset and is blind to
  the platform with the second-highest post volume.
- **Effort.** Medium.
- **Blocked by.** agent.
- **Confidence.** verified 2026-09-17.

### M11 — The content engine's total lifetime return is ~46k impressions and zero customers
- **What.** Not a defect — the number nobody has put in one place.
- **Evidence.** `post_analytics` totals: 45,875 impressions, 246 engagements
  (Facebook 5,374 / 35, LinkedIn 39,342 / 117, Instagram 1,159 / 94) across ~500
  published posts. `subscriptions`: last new paying customer **2026-05-28**.
- **Impact.** 112 days of daily multi-platform posting with no attributable revenue.
  This belongs in front of Heath as a strategy decision, not a fix.
- **Effort.** n/a — decision.
- **Blocked by.** Heath (judgment call).
- **Confidence.** verified 2026-09-17.

### M12 — Cold email is halted only by empty data, and the remediation was never finished
- **What.** 838 emails sent 2026-06-17 → 2026-08-28, 617 bounces (29% lifetime),
  **zero sales**. It stopped because `cold_email_cadence` is empty and
  `cron-cold-email-daily-batch` is not in `vercel.json`'s cron array — not because
  anything was fixed.
- **Evidence.** `outbound_email_queue`: 838 `sent`, last 2026-08-28.
  `email_events`: 617 `bounced`, last 2026-08-25; deliveries continue through today,
  so the domain is not blocked. `email_suppression_list`: 586 rows added
  2026-09-01 under `bounce-cleanup-20260901`. **`FROM_EMAIL` in
  `api/cron-cold-email-daily-batch.js:45` is still `heath@meetdossie.com`** — the
  same domain that sends receipts and password resets. `grep` finds no marketing
  subdomain anywhere in `api/`, `scripts/` or `docs/`.
- **Impact.** Step 1 of the remediation (suppress the guessed addresses) was done.
  Step 3 — split transactional mail onto a subdomain that never sends cold mail —
  was not. Anyone who repopulates `cold_email_cadence` repeats the incident against
  the transactional domain. Step 2 (check Resend for a reputation warning) has no
  record of ever being done.
- **Effort.** Small for the subdomain split; small to check Resend.
- **Blocked by.** mixed — agent can configure and verify; Heath owns the DNS record.
- **Confidence.** verified 2026-09-17.

### M13 — Alarms fire daily and nothing responds
- **What.** Eleven distinct `alert_state` keys fired on 2026-09-16/17:
  `silence:youtube:dossie`, `silence:tiktok:dossie`, `silence:instagram:dossie`,
  `silence:instagram:heath-realtor`, `silence:facebook:heath-realtor`,
  `linkedin_login_required`, `approvals_stale:social_posts`,
  `approvals_stale:group_posts`, `drafts_stale:group_posts`,
  `backlog:*:pending_video`, `tc_harvest_no_permalink`.
- **Evidence.** `alert_state` ordered by `last_fired_at`.
- **Impact.** The detection layer built under `feedback_silent-failure-is-the-enemy`
  works correctly. Every item M1-M9 above was already being reported daily. The gap
  is entirely in the response loop — which is exactly what this backlog is meant to
  feed.
- **Effort.** n/a — this is the argument for wiring `alert_state` in as an autonomous-loop
  signal source alongside `docs/TECH-DEBT.md`.
- **Blocked by.** agent.
- **Confidence.** verified 2026-09-17.

### M14 — `posting_schedule` has duplicate Twitter rows with conflicting `is_active`
- **What.** Twitter has 14 rows — one active and one inactive for each day of the
  week. Every other platform has 7.
- **Evidence.** `posting_schedule` grouped by platform/day/is_active.
- **Impact.** Low today (Twitter posts fine), but a gate table that disagrees with
  itself is how a platform silently stops.
- **Effort.** Small.
- **Blocked by.** agent.
- **Confidence.** verified 2026-09-17.

---

## 2. DOSSIE GO-TO-MARKET

### G1 — Five of eight paying customers have never used the product
- **What.** Every `onboarding_progress` flag is false for Kimberly Herrera, Cecilia
  Whitley, Terry Katz, Natalie Megerson and Lisa Nilsson — never opened a dossier,
  never played a morning brief, never uploaded a document, never talked to Dossie.
  Signup dates 2026-05-19 to 2026-05-28.
- **Evidence.** `onboarding_progress` joined to `profiles`, queried today. Miki
  (partial, `set_compliance_email` false) and Amanda (partial) are both cancelling
  2026-09-20. The only fully-complete non-Heath row is Brittney's, and its
  `completed_at` is the 2026-05-07 backfill timestamp shared by Heath's own accounts —
  treat it as a seed, not evidence of use.
- **Impact.** $145/mo of $204 MRR sits on accounts with zero product contact after
  ~4 months. Two of eight have already given notice. This is not a churn risk, it is
  churn that hasn't been processed yet.
- **Effort.** Medium — five real conversations.
- **Blocked by.** mixed — an agent can draft per-customer outreach and assemble the
  evidence; the calls are Heath's.
- **Confidence.** verified 2026-09-17.

### G2 — The Stripe webhook has never received a subscription-update or payment-failure event
- **What.** `api/stripe-webhook.js` contains full handlers for
  `invoice.payment_failed` (marks `past_due`, notifies Telegram) and
  `customer.subscription.updated` (syncs status and period dates). Neither has ever
  fired.
- **Evidence.** `stripe_webhook_events` holds **9 rows, all
  `customer.subscription.deleted`**, last 2026-08-05. Nothing else, ever. Corroborating:
  `current_period_end` on active subscriptions is 2-3 months stale — Kimberly
  2026-07-19, Cecilia 2026-07-20, Natalie 2026-07-22, Terry 2026-06-20, Tiffany
  2026-06-16, Brittney 2026-06-06, Suzanne 2026-06-01, Lisa **null** — while all read
  `status='active'`. Heath's own 2026-08-24 `cancel_at_period_end` change on Miki and
  Amanda produced no logged event either.
- **Impact.** Three compounding consequences. (a) Nobody knows whether these eight
  people are actually paying; the $204 MRR figure is unreconciled. (b) The dunning
  policy in `no-dunning-process-failed-payments.md` is still described as
  "awaiting Heath's decision" when the *code* already exists and simply never runs.
  (c) A `past_due` customer keeps full access indefinitely — which is how Zelda
  churned.
- **Effort.** Small. Almost certainly enabling two event types on the webhook
  endpoint in the Stripe dashboard.
- **Blocked by.** Heath (Stripe dashboard). The reconcile afterwards is agent work.
- **Confidence.** verified 2026-09-17.

### G3 — The referral program was built for every customer and never launched
- **What.** 13 affiliate links generated in one batch on 2026-06-12, one per
  customer, all `active=true`. 97 days later: 0 referrals, 0 earnings, 0 payouts.
- **Evidence.** `affiliate_links` (13 rows, all zeros), `affiliate_referrals` (0),
  `affiliate_payouts` (0).
- **Impact.** Word-of-mouth is the only channel that has ever produced a customer —
  Zelda came in via Terry. The mechanism to systematise it was built and never
  mentioned to anyone.
- **Effort.** Small — the links exist; this is an announcement.
- **Blocked by.** mixed — agent drafts, Heath approves the send.
- **Confidence.** verified 2026-09-17.

### G4 — Brittney's testimonial ask is ~18 weeks overdue and no system covers it
- **What.** Promised at 30 days. She signed up 2026-05-06.
- **Evidence.** `docs/CUSTOMERS.md` row 3 and the BRITTNEY CONTEXT block, both
  flagged in the 2026-08-26 lifecycle audit as having no record of ever being sent.
  Explicitly noted there: `cron-testimonial-request` does **not** cover this — that
  cron asks *members* to request *their clients'* reviews, a different flow entirely.
- **Impact.** She is the most important early customer and the source of the entire
  Control marketing pillar. There is not one customer quote about Dossie on file.
- **Effort.** Small.
- **Blocked by.** Heath (relationship).
- **Confidence.** inherited — `docs/CUSTOMERS.md`, not re-verified against her inbox.

### G5 — Natalie Megerson: the only Team-tier lead, ~17 weeks with no follow-up
- **What.** Flagged as a HOT team lead on signup day (2026-05-22) after mentioning a
  large San Marcos team. DM'd that morning. Nothing since.
- **Evidence.** `docs/CUSTOMERS.md` row 10, flagged overdue in the 2026-08-26 audit.
  Compounded by G1 — her `onboarding_progress` is entirely false, verified today.
- **Impact.** The only multi-seat opportunity on the books, and she has never opened
  the product she'd be expanding.
- **Effort.** Small.
- **Blocked by.** Heath (relationship).
- **Confidence.** mixed — the stale follow-up is inherited; the zero product usage is
  verified 2026-09-17.

### G6 — The inbound funnel has produced one real lead in its lifetime
- **What.** Every capture surface is empty of real prospects.
- **Evidence.** `founding_applications`: 5 rows, of which **4 are Heath's own tests**
  (`heathtestaccount@`, `heath.shepard+diag@`, "QA Test - Claude (Ignore)", and his
  own rejected row) — the only genuine application ever received is Brittney's,
  2026-05-06. `sales_leads`: 1 row, `brokerage='QA TEST - not a real inquiry'`.
  `waitlist`: 3 rows — one QA, one `ridge-phaseD-calc-test@`, and **one real
  address, betsybarrnb@gmail.com from 2026-05-22, still `status` untouched 118 days
  later**. `calculator_signups`: 1 row.
- **Impact.** Every customer Dossie has came from outbound or word-of-mouth. The site
  has never converted. Separately: the one real waitlist signup was never worked.
- **Effort.** Small to work the one lead. The funnel problem is a strategy question.
- **Blocked by.** mixed — agent drafts the one outreach; the funnel decision is Heath's.
- **Confidence.** verified 2026-09-17.

### G7 — Four cancellations, zero recorded reasons
- **What.** `cancellation_feedback` is empty. Zelda, Jennifer, Miki and Amanda all
  churned and no exit-survey row exists for any of them.
- **Evidence.** `select count(*) from cancellation_feedback` → 0. Table comment says
  it captures the Settings → Billing → Cancel flow, "one row per cancel attempt
  regardless of whether the Stripe cancellation succeeded."
- **Impact.** 33% of the customer base has left and there is no data on why. Miki and
  Amanda were cancelled by Heath directly in Stripe, which bypasses the flow — so the
  instrument may be fine and simply never exercised. Either way the information is gone.
- **Effort.** Small — ask the four directly.
- **Blocked by.** Heath (relationship).
- **Confidence.** verified 2026-09-17 (the table is empty); cause not established.

### G8 — `cron-pierce-activation` exists but is not scheduled anywhere
- **What.** The daily Telegram digest of founding members inactive >7 days — the one
  automated signal that would have surfaced G1 months ago.
- **Evidence.** `api/cron-pierce-activation.js` exists on disk. `grep -c
  "cron-pierce-activation" vercel.json` → **0**. Its own header says it is meant to be
  triggered by an external cron-job.org registration "NOT in vercel.json — Vercel is at
  limit." No doc records that registration ever being completed.
- **Impact.** Five customers went 4 months unnoticed. This is the alarm that was
  supposed to catch it.
- **Effort.** Small.
- **Blocked by.** mixed — agent can wire it; the cron-job.org account is Heath's.
- **Confidence.** verified 2026-09-17.

### G9 — The "SET IN STONE" weekly A/B test has run zero times
- **What.** `docs/WEEKLY-MARKETING-PLAN.md` mandates exactly one funnel test shipped
  every Wednesday, logged in `docs/FUNNEL-TESTS.md`.
- **Evidence.** `ls docs/FUNNEL-TESTS.md` → **No such file**. The plan was written
  2026-08-25; that is 3 missed Wednesdays, and the 2026-08-26 audit already recorded
  that no test had ever been logged.
- **Impact.** Small directly. It matters as the clearest example of a written
  operating rhythm that was never executed once.
- **Effort.** Small.
- **Blocked by.** agent (to run and log a test); Heath to approve live copy changes.
- **Confidence.** verified 2026-09-17.

### G10 — Ginger Unger partnership: DM'd 2026-05-21, nothing since
- **What.** `docs/TECH-DEBT.md` calls her FB group the "highest-leverage distribution
  lead" — Miki and probably Amanda both found Dossie through it. Three actions were
  scoped (thank-you DM + founding spot, affiliate % of MRR, paid endorsement).
  Only the DM happened.
- **Evidence.** `docs/TECH-DEBT.md`, NOT DONE section.
- **Impact.** The single highest-converting acquisition source Dossie has ever had,
  unworked for 4 months. Note founding is closed, so the original offer no longer
  exists — the affiliate route (G3) is the live one.
- **Effort.** Small.
- **Blocked by.** Heath (human relationship).
- **Confidence.** inherited.

### G11 — 15 of 18 Ridge customer-experience incidents are unresolved
- **What.** Includes 2 `critical` (last 2026-07-24), 1 `major`, 1 `high`.
- **Evidence.** `customer_experience_incidents` grouped by severity/resolved. Last
  incident logged 2026-08-22, suggesting the watchdog itself may also be quiet.
- **Impact.** Unknown without reading each one. Flagged here because it is
  customer-facing; **the remediation is likely engineering scope and belongs to the
  other inventory.**
- **Effort.** Small to triage.
- **Blocked by.** agent (triage only).
- **Confidence.** verified 2026-09-17.

---

## 3. HEATH'S REAL ESTATE BUSINESS

The website build is in flight and largely handled. Only what remains is listed.

### RE1 — 507 Ridge Bluff: financing contingency dies today, lender has refused the structure
- **What.** Jeremy Dean (CMG) said 2026-09-15 he "exhausted all options" and will not
  lend with title vesting in an LLC the borrowers don't own (reverse-1031 / QI
  structure). Buyer Approval deadline is **Thu 2026-09-17**. No reply since.
- **Evidence.** `jarvis_todos` "URGENT 507 Ridge Bluff — lender won't lend with LLC
  vesting", created 2026-09-15 21:02, still open.
- **Impact.** Buyers lose the financing contingency today on a $634,300 purchase.
  $5,000+ earnest exposure, with the same clients who just finished the Low Oak
  earnest-money fight.
- **Effort.** Small — a call, possibly an extension amendment.
- **Blocked by.** Heath (client call; the vesting structure routes to the QI/attorney).
- **Confidence.** verified 2026-09-17.

### RE2 — 507 Ridge Bluff: amendment out for seller signature, unexecuted
- **What.** The Sept 21 / Oct 9 amendment went to Wesley Boyd 2026-09-16 4:53pm cc
  Jessica Guevara. Not executed. The option period lapsed 09-16 5pm and only this
  amendment restores it; a precautionary termination notice sits with title.
- **Evidence.** `jarvis_todos`, created 2026-09-16 21:53, open.
- **Impact.** The buyers' termination right is in limbo. Wrong outcome is a second
  earnest-money dispute.
- **Effort.** Small.
- **Blocked by.** Heath.
- **Confidence.** verified 2026-09-17.

### RE3 — Pfeiffers Gate: option expires Fri 2026-09-18 5pm with the ¶7D amendment still an unsent draft
- **What.** Contract executed 2026-09-09 with **neither As-Is box checked in ¶7D** and
  ¶5I water supplier blank. "Amendment #1 - 5/26 - TXR-1903A" has been a saved zipForm
  draft since ~09-15, never sent for e-sign.
- **Evidence.** `jarvis_todos` "Pfeiffers Gate paragraph 7D decision" (updated
  2026-09-15) and "Pfeiffers Gate — option period expires FRI 9/18 5:00 PM".
- **Impact.** A $647,000 seller-side contract closing 10/16 with an ambiguous as-is
  election — the exact failure `feedback_verify-contract-elections-before-execution.md`
  was written about. Also blocks the KW Command compliance upload.
- **Effort.** Small once Heath says go.
- **Blocked by.** Heath (send authorization).
- **Confidence.** verified 2026-09-17.

### RE4 — Pfeiffers Gate: the T-47 affidavit may be false
- **What.** Sellers swore "None" for changes since the 2020-04-24 survey on
  2026-09-16, but an appraisal shows a wood fence that isn't on that survey.
- **Evidence.** `jarvis_todos`, created 2026-09-16 16:03, open.
- **Impact.** A sworn affidavit that is wrong. Title/survey objection risk and a
  fiduciary problem with his own sellers.
- **Effort.** Small — one call.
- **Blocked by.** Heath (his clients).
- **Confidence.** verified 2026-09-17.

### RE5 — Three KW Command compliance files incomplete; "Submit to MC" never clicked
- **What.** (a) 104 Wild Cherry — returned 2026-09-09 over a page-11 broker license
  error; corrected doc uploaded the same day at 3:18pm, **only the resubmit click
  remains**. (b) Pfeiffers Gate opp 14128479 — missing ¶7D amendment, T-47, CMA, CMA
  Ack, MLS Agent Report, Wire Fraud Warning. (c) 507 Ridge Bluff opp 14192281 — SDN and
  Oak Wilt Notice held back as partially signed; missing IABS, Buyer Rep, Wire Fraud
  Warning. (d) 130 Senisa opp 14128367 — **all 27 slots empty**.
- **Evidence.** Three open `jarvis_todos` rows (2026-09-10 / 09-15);
  `property-130-senisa.md`; `listing-104-wild-cherry.md`.
- **Impact.** Wild Cherry closed 2026-09-09 and **the DA (commission disbursement) has
  still not been issued** — Heath's own commission is unpaid, and the returned folder
  is the likely cause. One click.
- **Effort.** Small for Wild Cherry; medium for the other two (document chase).
- **Blocked by.** Heath — "Submit to MC is Heath's click, always."
- **Confidence.** verified 2026-09-17 (todos open). DA status inherited from 2026-09-10.

### RE6 — 130 Senisa is listed with no executed listing agreement on file
- **What.** No TXR-1101 in zipForm, OneDrive or Gmail. The only trace is a July **2025**
  email to TC Sarah Mitchum via Paperless Pipeline.
- **Evidence.** `property-130-senisa.md` "Open gap" (modified 2026-09-11). Listing
  confirmed live today: `listing_marketing_status` MLS 1997664, $389,000, ACT.
- **Impact.** Advertising an agent-owned property with no listing agreement — a
  TREC/brokerage exposure and an unenforceable commission if it sells.
- **Effort.** Small — one email to Sarah Mitchum.
- **Blocked by.** mixed — agent drafts; Heath approves the send.
- **Confidence.** listing verified 2026-09-17; the missing agreement is inherited.

### RE7 — 702 Fawndale is listed and un-showable, with four loose ends
- **What.** MLS 2015607, $330,000, status still `NEW`. Make-ready has no written
  completion date (Bobbye Joe McMillan at Cornerstone emailed 2026-09-11, no reply;
  Heath said verbally on 09-13 "should happen this week" — that week has ended). Also
  open: the Select Portfolio payoff was never pulled, TXR-1101 is staged unsigned, the
  yard sign isn't installed, and the KW-fee question on an agent-owned/LLC listing was
  never put to Joe Sloan.
- **Evidence.** `listing_marketing_status` verified 2026-09-17;
  `property-702-fawndale.md`; four open `jarvis_todos` rows from 2026-09-10.
- **Impact.** Burning DOM on a house that can't be shown, and the net sheet isn't final
  without a real payoff.
- **Effort.** Medium.
- **Blocked by.** mixed — payoff call and the Joe Sloan question are Heath's; the
  Cornerstone chase can be agent-drafted.
- **Confidence.** MLS status verified 2026-09-17; make-ready inherited from 09-13.

### RE8 — 23 Nopalito: two live buyer parties surfaced a week ago, neither converted to a showing
- **What.** Craig Browning's buyer (already toured once) responded the first day at
  $999,000 and **has still not scheduled a showing**. A second, unrelated showing
  request from a different agent is also unresolved. Nothing recorded after 2026-09-12.
- **Evidence.** `craig-browning-nopalito-buyer-agent.md`; `showingtime_feedback` has
  **zero Nopalito rows after 2026-09-04** — no showing logged since the price cut.
- **Impact.** The only two live prospects after 324 DOM, against the seller's own
  two-week ultimatum (Jenny Whyte, 09-10 → ~09-24). If nothing lands the listing comes
  off market.
- **Effort.** Small.
- **Blocked by.** mixed — agent drafts; Heath sends (he emailed Craig himself 09-11,
  so read that thread first).
- **Confidence.** the showing-data gap verified 2026-09-17; the buyer threads inherited
  from 09-11 and six days stale.

### RE9 — The listing-marketing generator detects all three listings and produces nothing
- **What.** `listing_marketing_status` refreshes nightly (last run 2026-09-17 00:00,
  all three rows) but `copy_ready=false` on **all three**, `photos_ready=false` on
  Nopalito and Fawndale, and `last_notified_price` / `last_photos_notified_at` are
  **null on all three** — nothing has ever been generated or notified.
- **Evidence.** live query of `listing_marketing_status`, 2026-09-17.
- **Impact.** The marketing that should follow a $196,000 price cut and a fresh listing
  never goes out.
- **Effort.** Medium.
- **Blocked by.** agent (photo curation on Senisa needs judgment — most interiors are
  excluded for tenant privacy).
- **Confidence.** verified 2026-09-17.

### RE10 — Heath's realtor Facebook page and Instagram have each posted exactly once, ever
- **What.** A full 4-week cadence exists in `docs/REALTOR-PAGE-CADENCE.md`. It ran for
  one day.
- **Evidence.** `zernio_accounts` — `@HeathShepardRealtor` (FB) and
  `@heathshepardrealtor` (IG) both connected 2026-08-18, `is_active=true`; YouTube
  "Shepard Real Estate Solutions" connected 2026-08-25. `social_posts` against those
  Zernio account ids: **1 posted each on FB and IG (2026-08-28), zero on YouTube, ever.**
  `alert_state` keys `silence:facebook:heath-realtor` and
  `silence:instagram:heath-realtor` both fired **2026-09-17**.
- **Impact.** Three active listings, zero organic distribution on his own realtor
  channels.
- **⚠️ Corrects a stale record.** `docs/REALTOR-PAGE-CADENCE.md` says "not connected to
  Zernio yet — blocked on Heath's manual OAuth re-auth click." **That is wrong.** All
  three accounts have been connected since August. Nothing is blocked on Heath here.
- **Effort.** Small.
- **Blocked by.** **agent** — but the doc's own stale prices must be corrected first
  (it still carries $1,295,000 for Nopalito, now $999,000, and lists Wild Cherry as
  active when it closed 2026-09-09).
- **Confidence.** verified 2026-09-17.

### RE11 — The Linton Google review request was never confirmed sent, and now can't be
- **What.** Heath asked on 2026-09-11 to text the Lintons a review request after Wild
  Cherry closed. Two send attempts each showed a delivered timestamp then vanished.
  Cannot rule out that one landed, so under `feedback_never-retry-an-unverified-send`
  it stopped at two.
- **Evidence.** `listing-104-wild-cherry.md`; `scripts/send-sms-phonelink.ps1` line 2
  `# DISABLED 2026-09-11`, line 18 `exit 99`.
- **Impact.** His GBP has **2 reviews**. A just-closed happy seller is the cheapest
  reputation asset he has, and six days of goodwill have decayed. This is also the
  exact behaviour he told Cole to turn into a Dossie product requirement.
- **Effort.** Small — 2 minutes from his own phone.
- **Blocked by.** Heath (must check the thread on his phone; the agent SMS path is off).
- **Confidence.** verified 2026-09-17.

### RE12 — Outbound client SMS has been disabled 6 days and nobody ran the re-enable gate
- **What.** Gated off 2026-09-11 after triple-texting a client. Re-enable requires 10
  clean self-test sends; none have been done. It **blocked a real client text on
  2026-09-16** on the Ridge Bluff deadline.
- **Evidence.** `jarvis_todos` "Outbound SMS still disabled", 2026-09-16, open; script
  header verified on disk.
- **Impact.** On deadline-dense files, text is the channel clients actually read.
  Everything now routes through Heath by hand.
- **Effort.** Small — an hour of supervised self-tests.
- **Blocked by.** mixed — agent can run the tests; Phone Link must be paired, which
  only clears from the phone.
- **Confidence.** verified 2026-09-17.

### RE13 — Duplicate Google Business Profile still not merged or removed
- **What.** Two profiles under two different Google accounts. The **keeper** is
  "Shepard Real Estate Team" (2 five-star reviews, 808 number) under
  heath.shepard@**gmail**.com. The **duplicate** is "Heath Shepard Real Estate Team"
  (0 reviews, 830 number) under heath.shepard@**kw**.com.
- **Evidence.** `heath-google-business-profile.md`; `HANDOFF.md` (2026-09-16). The
  2026-09-16 extension run stopped without acting because **the brief had keep/delete
  backwards and would have deleted the only profile Heath controls.**
- **Impact.** Review equity split across two pins, map-pack dilution on his single
  biggest free local lead source. Also a TREC §535.155 issue — the duplicate advertises
  an assumed name that isn't registered.
- **Effort.** Small — 15 minutes once signed into the right account.
- **Blocked by.** Heath (must sign into business.google.com as heath.shepard@gmail.com).
- **Confidence.** verified 2026-09-17 (both sources agree it hasn't happened).

### RE14 — Website punch list: Wix items B, C, E plus placement of two written pages
- **What.** Item A is done and **saved but not published**. B (replace the booking
  element — Wix Bookings needs a paid plan), C and E are not started. Still open from
  the 2026-09-06 status: the **/boerne page and short-term-rental page, both written,
  neither placed**, FAQ schema, cited market stats, the photo upload from
  `C:\Users\Heath\Desktop\wix-upload` (OS file picker, extension can't drive it), the
  mobile hero design call, and a duplicate unpublished Wix site nobody has touched.
- **Evidence.** `HANDOFF.md`; `wix-realtor-site-audit.md`;
  `docs/site-content/boerne-page.md` exists on disk (written 2026-09-16, **untracked
  in git**).
- **Impact.** Modest — the site does ~10-16 sessions/month and has produced zero real
  leads. Compliance is already 6/6, so there is no live TREC exposure on the site.
- **Effort.** Medium, spread across items.
- **Blocked by.** mixed — photo upload and the design call are Heath's; the rest is
  extension work.
- **Confidence.** verified 2026-09-17.

### RE15 — The site links an 11-year-old IABS form
- **What.** The linked PDF is IABS 1-0 dated 2015-11-02. The current form is **IABS 1-2,
  effective 2026-01-01**. Its prefilled phone is also wrong.
- **Evidence.** `wix-realtor-site-audit.md`, still listed open as of 2026-09-06.
- **Impact.** Low probability, non-zero regulatory risk on a consumer disclosure that
  appears on every page.
- **Effort.** Small — 30 minutes.
- **Blocked by.** Heath (zipForm profile edit + Wix upload picker).
- **Note.** "Keller Willis San Antonio Inc" is the **correct registered entity name** —
  do not "fix" that part.
- **Confidence.** inherited.

### RE16 — GA4 is parked awaiting one word from Heath
- **What.** The extension will fill the entire GA4 property + web stream form and stop
  before Create. Heath clicks Create. The goal is the G- Measurement ID.
- **Evidence.** `HANDOFF.md`. Analytics confirmed entirely absent from served HTML.
- **Impact.** No traffic data at all, so no way to tell whether any site work moved
  anything.
- **Effort.** Small — 10 minutes.
- **Blocked by.** Heath (one click).
- **Confidence.** verified 2026-09-17.

### RE17 — Unresolved instruction: "send it to title with Wes on the email at 4pm today"
- **What.** Cole asked what "it" referred to. No answer is recorded. "Wes" most
  plausibly means Wesley Boyd, the 507 Ridge Bluff listing agent — which would make
  this a deal instruction with a stated deadline, not a website one.
- **Evidence.** `HANDOFF.md`, "Unclear request" and "What's Next".
- **Impact.** Possibly a missed send on a live file. Per
  `feedback_ask-when-timing-conflicts`, a stated send time is an instruction.
- **Effort.** Small — one question.
- **Blocked by.** Heath (only he knows what "it" was).
- **Confidence.** verified 2026-09-17 that it is unresolved. The Wesley Boyd reading is
  inference, not established.

### RE18 — Kanika Jain testimonial: agreed 2026-08-31, gated on a closing now at risk
- **What.** "Do not ask mid-transaction. Once the second property closes, ask Kanika for
  a written testimonial." Her name may not appear anywhere without direct permission.
- **Evidence.** `clients-kanika-jain-ketan-thakkar.md`, "Pending ask — testimonial".
- **Impact.** The strongest available proof for the investor positioning — bought
  sight-unseen from out of state in 2024, repeat buyer 2026 — now hostage to RE1.
- **Effort.** Small, once it closes.
- **Blocked by.** Heath (client relationship + her explicit consent).
- **Confidence.** inherited.

### RE19 — `esign_events` stopped recording 2026-09-02
- **What.** 15 days blind. The Nopalito Amendment #3 (09-10), the Pfeiffers execution
  (09-09), the $634,300 price amendment (09-15) and the Low Oak release (09-14/15) all
  happened and none were captured.
- **Evidence.** `select count(*), max(event_at) from esign_events` → 79 rows, max
  2026-09-02 23:55.
- **Impact.** The audit trail Heath relies on to answer "did they actually sign?" —
  the precise failure `feedback_poll-system-of-record-not-notifications` exists to
  prevent. Plausibly collateral of RE21, but Authentisign notifications were still
  landing 09-09, so it may be its own break.
- **Effort.** Medium.
- **Blocked by.** **agent.**
- **Confidence.** verified 2026-09-17.

### RE20 — `showingtime_feedback` stopped recording 2026-09-04, and 26 of 33 rows were never filed
- **What.** 13 days dead. Unfiled by property: Low Oak 7, Royal Crescent 7, Old
  Homestead 5, Mount Vieja 3, Mount Rainier 2, Serene Creek 1, Ridge Bluff 1.
- **Evidence.** `select count(*), max(created_at) from showingtime_feedback` → 33 rows,
  max 2026-09-04 21:01.
- **Impact.** No showing feedback captured on Nopalito since the price cut — exactly the
  window where it matters, and the only evidence that would tell the Whytes whether to
  extend past their ultimatum. Compounds RE8.
- **Effort.** Medium.
- **Blocked by.** **agent.**
- **Confidence.** verified 2026-09-17.

### RE21 — KW inbound email still rejecting, 7 days, marked UNRESOLVED
- **What.** `550 5.7.1 Message rejected due to administrative security policy` on
  inbound mail to heath.shepard@kw.com since 2026-09-09/10. The sender gets a bounce;
  Heath gets silence.
- **Evidence.** `kw-email-blocking-incident-2026-09-10.md`, status UNRESOLVED. No newer
  file contradicts it.
- **Impact.** An unknown number of client and e-sign messages silently rejected for a
  week. He cannot enumerate what he never received. Plausible root cause of RE19.
- **Effort.** Small — one support ticket.
- **Blocked by.** Heath (account holder).
- **Confidence.** inherited — **run a live deliverability test before acting; this may
  have self-resolved.**

### RE22 — The SMS poller is 3 days stale
- **What.** `sms_messages` runs unbroken 09-03 → 09-14 then stops.
- **Evidence.** `max(sent_at)` = 2026-09-14 22:44 UTC.
- **Impact.** Not yet lossy — the Phone Link window is 30 days — but client texts from
  09-15 to 09-17 are invisible during the most deadline-dense week on the books.
- **Effort.** Small — one command.
- **Blocked by.** **agent** (requires Phone Link paired).
- **Confidence.** verified 2026-09-17.

### RE23 — None of Heath's own deals produce deadline reminders from his own product
- **What.** `deadline_reminders` has 201 rows sent as recently as today, and **not one
  belongs to any of Heath's three user_ids.** Cause is visible in his own records: Wild
  Cherry still `status='active'` with `closing_date='2026-09-02'` (it closed 09-09);
  Pfeiffers Gate `option_days=0`, untouched since 2026-08-15; Nopalito and Senisa have
  null effective/closing dates; **Ridge Bluff and Fawndale aren't in the table at all**;
  plus three stale Wild Cherry duplicates and two `123 Main St` test rows.
- **Evidence.** live query filtered strictly to Heath's own profile ids, 2026-09-17.
- **Impact.** Every date in RE1-RE4 is tracked only in `jarvis_todos` and memory. It
  also means the post-closing testimonial trigger could never have fired on Wild
  Cherry — which is precisely why RE11 became a manual scramble.
- **Effort.** Medium.
- **Blocked by.** **agent** (data reconciliation). The underlying date-computation bug
  is engineering scope and already tracked separately.
- **Confidence.** verified 2026-09-17.

### RE24 — Lead-Based Paint addendum gap, deferred 2026-08-19, never resumed
- **What.** 9207 Old Homestead (built 1967) went out **without** an LBP addendum. Heath's
  call at the time: "hold off for now."
- **Evidence.** `clients-kanika-jain-ketan-thakkar.md`, 2026-08-19 section.
- **Impact.** 42 USC §4852d requires buyer election and signature on pre-1978 stock. Low
  Oak terminated and Royal Crescent is dead, so Old Homestead is the only live exposure —
  **if it's still alive.** Its status isn't recorded anywhere after 2026-08-21.
- **Effort.** Medium.
- **Blocked by.** Heath (he deferred it deliberately).
- **Confidence.** inherited and **likely stale — confirm Old Homestead is dead before
  spending time here.**

---

## 4. RUST — STORE SUBMISSION AND LAUNCH

Code and features are out of scope. **Read the staleness note in section 7 first** —
both Rust marketing docs open by naming a blocker that has since been solved.

### RM1 — Android production access blocked on 12 opted-in testers; 4 are opted in
- **What.** Google requires 12 opted-in closed testers held 14 consecutive days. The
  clock has never started.
- **Evidence.** `play-console-tester-list-traps.md` — "15 addresses on the list, 2 of
  them Heath's own, but only 4 opted in". `jarvis_todos` "Text contacts to recruit 9
  more Android beta testers for Rust", created 2026-08-31, still open — **17 days**.
- **Impact.** The single hard gate on the entire Android launch.
- **Effort.** Medium — needs ~25-30 asks to land 12 at typical conversion, then 14 days
  of waiting.
- **Blocked by.** Heath (real people, real asks, Gmail addresses only).
- **Confidence.** todo verified 2026-09-17; tester count inherited.

### RM2 — The D-U-N-S application that would bypass RM1 entirely was never started
- **What.** Converting Apple to Organization was deferred until after 1.0, with an
  explicit instruction to start the D-U-N-S application in parallel now.
- **Evidence.** `rust-apple-support-case-2026-09-11.md`.
- **Impact.** Material and under-appreciated: per `play-console-tester-list-traps.md`,
  an **organization** Play account is **exempt from the 12-tester rule entirely**. The
  D-U-N-S takes ~1 week and is free. Not starting it keeps RM1 as the critical path
  when it doesn't have to be.
- **Effort.** Small — ~30 minutes to file.
- **Blocked by.** Heath (entity identity, D&B application).
- **Confidence.** inherited.

### RM3 — Four fabricated claims still live in the hook library
- **What.** Hooks #20 and #35 claim an automatic 5th-week deload that does not exist in
  the codebase. Hooks #11 and #15 state a 1-10 sleep slider (it's 1-5) and auto-rewriting
  of the session (the coach only recommends).
- **Evidence.** `marketing/rust-hook-library.md` read on disk 2026-09-17 — line 76 still
  reads *"Deload week hits automatically every 5th week"*, line 106 *"I stopped guessing
  my own deload weeks. The app just does it"*, lines 62 and 71 *"3 out of 10."* All four
  unchanged. Flagged in `RUST-PRELAUNCH-MARKETING-PLAN.md` and `RUST-INFLUENCER-PROGRAM.md`,
  both 2026-09-14, with replacement text already written.
- **Impact.** Marked ❌ Fabricated. This is `dossie-demo-must-match-real-capability`
  applied to Rust. One of these in a TikTok overlay is a false advertising claim on a
  health app.
- **Effort.** Small — 15 minutes.
- **Blocked by.** **agent.** Cheapest open item in this document.
- **Confidence.** verified 2026-09-17.

### RM4 — No subscription products exist in either store, so IAP ships dark
- **What.** Native IAP was built 2026-09-16 and cannot activate, because gate #4 requires
  the store to return a real product and none exist.
- **Evidence.** `Rust/src/lib/billing.ts` lines 28-40 list five gates; #4 reads
  "Products not created yet, Apple's Paid Apps Agreement not active, RevenueCat
  misconfigured..." Commit `59b8f93`.
- **Impact.** Rust earns **$0** on mobile regardless of what ships. Also strands the
  influencer program's promo-code path.
- **Effort.** Medium — half a day per store, plus RevenueCat config and the
  `app_versions.purchases_enabled` flip.
- **Blocked by.** mixed — store-side product creation is Heath's; RevenueCat wiring is
  agent work.
- **Confidence.** verified 2026-09-17.

### RM5 — Rust's public support contact is Heath's Keller Williams address
- **What.** `rustfitness.app/support.html` publicly lists `heath.shepard@kw.com`.
- **Evidence.** live fetch of that URL, 2026-09-17. `jarvis_todos` "Switch Rust App
  Store Connect review contact off heath.shepard@kw.com", created 2026-08-29, open.
- **Impact.** Two problems compounded — a KW compliance smell on a non-real-estate
  commercial product, **and** kw.com inbound mail has been silently rejecting since
  2026-09-10 (RE21), so a creator's or user's reply can simply vanish. Named as a
  blocker in both Rust marketing docs.
- **Effort.** Small — ~20 minutes, ImprovMX on `rustfitness.app`, the same setup
  MeetDossie already runs. The domain now exists, so nothing blocks it.
- **Blocked by.** mixed — agent does most; Heath makes the DNS call and edits ASC.
- **Confidence.** verified 2026-09-17.

### RM6 — No Rust social accounts existed for 33 days; two were created today
- **What.** Two todos open since 2026-08-15 ("Create rust instagram", "Have fun on the
  socials with rust"). Prerequisite #3 of 7 in the influencer program.
- **Evidence.** both `jarvis_todos` rows still open. **But**: `zernio_accounts` gained
  `@ruststrength` on Instagram and `@Ruststrength` on Twitter at **2026-09-17 14:46**
  today. TikTok and YouTube still have no Rust handle.
- **Impact.** Partially resolving. Heath cannot warm up on creators' content from an
  account that doesn't exist, and every rendered video has had nowhere to go.
- **Effort.** Small for the remaining platforms.
- **Blocked by.** Heath (phone verification per platform).
- **Confidence.** verified 2026-09-17. **Close the two todos and rescope to TikTok/YouTube.**

### RM7 — iOS 1.0 has been in review 18 days; Apple has ignored the same question twice
- **What.** "Waiting for Review" since 2026-08-30/09-06. Two cases open. The expedite
  allowance is deliberately unspent.
- **Evidence.** `rust-apple-support-case-2026-09-11.md` — case 102959779695
  (membership) and App Review case 102964343759 filed 2026-09-15.
- **Impact.** Launch delay of unknown length, with one lever still unused.
- **Effort.** Small — a follow-up reply, or spend the expedite.
- **Blocked by.** Heath (his Apple ID, his support thread).
- **Confidence.** inherited — App Store Connect is not readable from here.

### RM8 — The influencer program's list exists; none of the warming has been done
- **What.** A 5-tier target list with a sequenced 10-step week-one plan, written
  2026-09-16. Nothing in it executed.
- **Evidence.** `RUST-INFLUENCER-PROGRAM.md` §6 item 5: *"This document is the list. The
  warming is not done."* §4.2 items 4-9 all unstarted.
- **Impact.** The doc's own thesis is that warming takes 2-3 weeks *before* any DM — and
  iOS is sitting in Apple's queue right now. That queue time is exactly the window the
  warming was designed to fill, and it is being burned.
- **Effort.** Medium.
- **Blocked by.** mixed — **list-building and UTM minting are agent work**; warming and
  DMs are Heath.
- **Confidence.** verified 2026-09-17.

### RM9 — Play Health declaration blocked on a stale permission scan
- **What.** The declaration page enumerates 47 `android.permission.health.*` entries from
  version code 2's manifest. The fix (4 permissions) is uploaded and Active as version 3;
  Google's scanner never rescanned despite two release updates and a full
  delete-and-recreate via API.
- **Evidence.** `rust-app-store-submission-state.md`. Binary verified at 4 permissions
  via Python zipfile.
- **Impact.** Heath must **not** complete the form while it shows 47 — attesting to 43
  permissions not in the binary is a false declaration to Google.
- **Effort.** Small — a support ticket, then waiting.
- **Blocked by.** Heath (Play Console support, gmail.com account).
- **Confidence.** inherited and **17 days stale — check the page before doing anything;
  this may have self-resolved.**

### RM10 — Codemagic's push trigger has been silently dead since ~2026-08-26
- **What.** Pushes stopped producing builds. Every iOS/Android build since has needed a
  manual "Start new build" click.
- **Evidence.** `rust-app-store-submission-state.md`.
- **Impact.** Silent-failure class — a "fix pushed" claim does not mean a build exists.
- **Effort.** Small — ~30 minutes to re-register.
- **Blocked by.** mixed — Heath's Codemagic login, possibly agent-doable if stored.
- **Confidence.** inherited.

### RM11 — Data Safety step 4: the Garmin third-party sharing question was never answered
- **What.** Rust has a real Garmin integration (`garmin_credentials`, `garmin_data`) that
  was never investigated. Step 4 asks whether data is *shared with* a third party.
- **Evidence.** `rust-google-play-submission-2026-08-20.md`, "Open item, not yet resolved."
- **Impact.** An unresearched answer is a false Data Safety declaration — same class as
  RM9.
- **Effort.** Small — ~1 hour of code reading.
- **Blocked by.** **agent** does the research; Heath submits the form.
- **Confidence.** inherited.

### RM12 — Play content rating was submitted with a known-wrong answer and left uncorrected
- **What.** The IARC questionnaire was answered "Yes, interactions can be limited to
  invited friends only," which is false — the Feed/Discover `search_users` RPC has no
  scoping.
- **Evidence.** `rust-google-play-submission-2026-08-20.md` — "one real mistake caught
  and left uncorrected in the original submission."
- **Impact.** Low-to-moderate. Ratings came back permissive anyway, but a misdeclaration
  on record is a policy-strike surface.
- **Effort.** Small — ~20 minutes.
- **Blocked by.** Heath (Play Console).
- **Confidence.** inherited.

### RM13 — Nine rendered videos, never reviewed, never posted
- **What.** 6 coach-intro + 3 conversation videos rendered 2026-09-14, untouched since.
- **Evidence.** 9 `.mp4` files in `Media/rust-conversations/`, all dated Sep 14 16:55-56.
  `RUST-PRELAUNCH-MARKETING-PLAN.md`: "Not posted, not in `video_library`."
- **Impact.** The content plan is gated on a format go/no-go. **Ambiguity to resolve
  first:** `feedback_every-video-needs-scroll-stopping-hook.md` records 9 Rust coach
  videos **rejected** on 2026-09-15 for lacking frame-1 hooks. These may be those same
  nine — in which case this is closed-and-failed, not pending.
- **Effort.** Small — 10 minutes of watching.
- **Blocked by.** Heath.
- **Confidence.** files verified 2026-09-17; review status ambiguous.

### RM14 — Two Play tester addresses will make every list save fail
- **What.** `b.montoya@hotmail.com` is not a Google account; `Josh@sisam.com` is a custom
  domain and likely isn't either. The save is atomic — one bad address fails the whole list.
- **Evidence.** `play-console-tester-list-traps.md`, confirmed pattern with
  `Scott.bogue@hhc07.com`.
- **Impact.** Blocks RM1. Compounded by a destructive empty-editor bug that can wipe all
  15 addresses — **confirm the rows render before typing anything.**
- **Effort.** Small — 15 minutes.
- **Blocked by.** Heath — and newly harder: the KW Workspace policy pins Chrome to
  kw.com, so Play Console (a gmail.com account) needs Incognito or a separate profile.
- **Confidence.** inherited.

### RM15 — The Planet Fitness manager email was never sent
- **What.** A gym manager gave Heath an address for in-gym materials. Nothing was sent.
- **Evidence.** `RUST-PRELAUNCH-MARKETING-PLAN.md` §11 action #5 ("Blocks: Nothing — just
  do it"); `RUST-INFLUENCER-PROGRAM.md` §4.2 item 10 ("warmer than any creator on the list").
- **Effort.** Small — 5 minutes.
- **Blocked by.** mixed — agent drafts; Heath sends (his relationship, his voice).
- **Confidence.** inherited.

### RM16 — Rust in-app feedback triage was never built
- **What.** Heath wants Send Feedback submissions triaged before he sees them, not raw
  Telegram dumps.
- **Evidence.** `jarvis_todos` row created 2026-08-27, still open.
- **Impact.** Launch-adjacent — the moment testers arrive this ships broken into a
  feedback surge.
- **Effort.** Medium — ~half a day.
- **Blocked by.** **agent.**
- **Confidence.** verified 2026-09-17.

### RM17 — The 13-clip Rust feature library was never built
- **What.** An overnight batch of per-feature clips with Marcus voiceover, music and
  burned-in captions.
- **Evidence.** `jarvis_todos` row created 2026-08-27, open — 21 days.
- **Effort.** Medium — one overnight render batch.
- **Blocked by.** **agent** — but **do not start until RM13's format go/no-go is
  resolved**, or it renders 13 more rejects.
- **Confidence.** verified 2026-09-17.

### RM18 — Two secrets were flagged for Bitwarden backup; neither was confirmed done
- **What.** (a) The Play Developer API service-account JSON key, (b) the Rust Supabase
  service-role key.
- **Evidence.** `rust-play-developer-api-service-account.md`;
  `rust-demo-community-account-2026-08-27.md`.
- **Impact.** The Play key exists in exactly two places — local
  `~/.rust-app-secrets/` and Vercel as a Sensitive var that cannot be read back. Losing
  the WSL filesystem loses it.
- **Effort.** Small — 10 minutes each.
- **Blocked by.** **agent** if `BW_SESSION` is available; otherwise Heath's master password.
- **Confidence.** inherited.

### RM19 — UPS Store mailbox activation never confirmed; its Apple purpose is now dead
- **What.** PS Form 1583 activation unconfirmed, and an open todo asks Heath to collect a
  mailbox ownership certificate.
- **Evidence.** `rust-llc-and-mailbox.md`; `jarvis_todos` row created 2026-08-26, open.
- **Impact.** $344/yr already spent. Apple **rejected** the notarized 1583 on 2026-09-15
  and Heath cancelled the address change, so the Apple case is gone. The Play
  developer-identity use remains, but only once the app monetizes.
- **Effort.** Small — one in-person trip.
- **Blocked by.** Heath.
- **Confidence.** todo verified 2026-09-17; 1583 status inherited.

### RM20 — Photo-scan equipment feature: correctly parked, with a named resume trigger
- **What.** Camera → vision model → map to the 121-item equipment catalog. Heath: *"Yes
  but I dont want to forget it."*
- **Evidence.** `rust-feature-backlog.md` §1. Resume trigger: **"Bring it up unprompted
  once Android production access clears"** — i.e. gated on RM1.
- **Impact.** None today. Listed only so the trigger isn't lost.
- **Blocked by.** gated on RM1.
- **Confidence.** inherited.

---

## 5. BUSINESS ADMIN

### BA1 — 702 Fawndale mortgagee must change to Fay Servicing, effective 2026-10-06
- **What.** The loan transfers from Select Portfolio Servicing to Fay Servicing, LLC on
  2026-10-06. The Allstate mortgagee clause must be updated once Fay's letter arrives.
- **Evidence.** `heath-insurance-portfolio.md`, final section.
- **Impact.** **19 days.** This exact failure already happened once on this exact
  property — the policy named Shellpoint while SPS held the loan, SPS never saw proof of
  coverage, and force-placed. Force-placed runs several times normal cost. RESPA
  12 CFR 1024.37(g) gives 15 days to cancel and refund, but only after you catch it.
- **Effort.** Small — one email to Amy Sorensen.
- **Blocked by.** mixed — Heath must forward the servicer letter from his mail; the
  agent can draft and send everything after that.
- **Confidence.** inherited.

### BA2 — 702 Fawndale security-deposit disposition, deadline ~2026-10-10, untracked
- **What.** Tex. Prop. Code §92.104 requires an itemized deduction list within 30 days of
  the later of surrender or receipt of the forwarding address. Lease ended 2026-09-04,
  forwarding address received 2026-09-10.
- **Evidence.** `texas-security-deposit-disposition.md`. **Verified today: there is no
  `jarvis_todos` row tracking this deadline** — there are three 702 Fawndale todos
  (payoff, listing, sign) and none for the deposit.
- **Impact.** **23 days.** §92.109 bad-faith retention exposure is **3× the deposit +
  $100 + the tenant's attorney's fees**. A real contractor bid is still needed for the
  gravel/paver restoration Heath elected not to perform.
- **Effort.** Small — one bid plus the letter.
- **Blocked by.** mixed — Heath for the bid; **agent can draft the itemized letter**.
- **Confidence.** deadline math inherited; the absence of tracking is verified 2026-09-17.

### BA3 — 2508 Via Anita (California) renews 2026-10-15 with four unanswered questions
- **What.** Dwelling Fire policy CASNL100003069, Bamboo Ide8 via USAA Insurance Agency.
  Open: (1) is it actually renewing — CA non-renewals are routine and notice arrives late;
  (2) wildfire terms, brush exclusions, defensible-space requirements; (3) admitted or
  surplus, which decides CIGA guaranty-fund protection; (4) what is the premium.
- **Evidence.** `heath-insurance-portfolio.md`, 2026-09-11 correction — "the NEAREST
  renewal on the whole board."
- **Impact.** **28 days.** A silent CA non-renewal on a house Cindy manages remotely
  means an uninsured dwelling. Premium unknown, so the $17,720 portfolio figure is low.
- **Effort.** Small — one call.
- **Blocked by.** Heath (policyholder identity verification).
- **Confidence.** inherited.

### BA4 — 713/715 Homer Ave S has zero liability coverage — quoted 2024, never bound
- **What.** A Citizens policy with no liability at all. Citizens also excludes theft and
  animal liability.
- **Evidence.** `heath-insurance-portfolio.md` — "STILL THE LARGEST RAW GAP. Shelby
  Mossey / Wunderlin quoted the fix 2024-12-05; no evidence he bought it."
- **Impact.** Uncapped. A tenant or guest injury at a rental duplex with zero liability is
  a direct personal-asset claim. **An umbrella cannot fix it** — umbrellas sit excess of
  required underlying limits and there is nothing underneath. Open **21 months**.
- **Effort.** Small — re-quote and bind, likely a few hundred dollars a year.
- **Blocked by.** Heath (signature, payment).
- **Confidence.** inherited.

### BA5 — 130 Senisa LLC is not a named insured on the policy covering its own property
- **What.** The property is titled in 130 Senisa LLC; the policy names Heath individually.
- **Evidence.** `heath-insurance-portfolio.md` — "a tenant injury names 130 Senisa LLC,
  which is NOT an insured on the policy. No doctrine rescues that."
- **Impact.** A property claim is probably fine under *Smith v. Eagle Star*, 370 S.W.2d
  448 (Tex. 1963). **A liability claim against the LLC gets no defense and no indemnity.**
  Fix is a mid-term endorsement changing the named insured — LLC named, individual as
  additional insured — not a new policy. Carriers want the recorded deed, SOS
  certificate, member list. **Do not cancel anything until the replacement is bound in
  writing.**
- **Effort.** Medium.
- **Blocked by.** mixed — **agent can assemble the document package**; Heath signs.
- **Confidence.** inherited.

### BA6 — No umbrella policy across a 7-property, 3-state portfolio
- **What.** Confirmed absent from the Allstate active list twice and from the account API.
- **Evidence.** `heath-insurance-portfolio.md` action item 4.
- **Impact.** Five rentals with $300-500k underlying limits and no excess layer.
  Estimate $1M ≈ $600-1,200/yr. **RLI specifically** — USAA, Allstate and GEICO all force
  the whole underlying program to move to them; RLI doesn't. Two prerequisites are open:
  210 English Oaks sits at $300k (raise to $500k, priced at $2-5/yr), and **the umbrella
  must schedule FIVE rentals, not four** — the California house was missed in the original
  count, and getting it wrong leaves a gap exactly where Heath would assume coverage.
- **Effort.** Medium — one RLI application.
- **Blocked by.** Heath (application, signature, payment).
- **Confidence.** inherited.

### BA7 — Class 4 impact-resistant roof credit: the one live insurance money item
- **What.** A UL 2218 credit Heath is not receiving, separate from the cosmetic-damage
  exclusion discount he already gets. Requires an Impact-Resistant Roofing letter signed
  by the installing roofer.
- **Evidence.** `heath-insurance-portfolio.md`, 2026-09-14 carrier corrections item 3 —
  "the one live item." Amy Sorensen sent a sample letter.
- **Impact.** 15-35% of the $5,585 home premium = **~$840-1,955/yr**. Catch: the roof
  went on in 2018 under the prior owner, so the installer is unknown — the path is any
  licensed roofer inspecting, identifying the panel product, and certifying.
- **Effort.** Small — one roofer inspection.
- **Blocked by.** Heath (his property, his scheduling).
- **Confidence.** inherited.

### BA8 — Truck refinance: $4,833 identified, never applied for
- **What.** 2024 Tundra at $45,280.71 @ 8.92%, 59 months left, $938.64/mo. RBFCU
  publishes 4.49% at 48 and 60 months → $856.73/mo.
- **Evidence.** `heath-savings-sweep-2026-09.md` item 2. Started 2026-09-09.
- **Impact.** **$4,832.94** over the loan term. Two traps flagged and unaddressed: GAP
  coverage dies at refinance (demand the unused premium back from Toyota), and
  refinancing can void **SCRA** benefits — check the Toyota loan for a rate cap first,
  which matters specifically because he is a veteran.
- **Effort.** Medium — PenFed soft-pull prequal first, then RBFCU → USAA → NFCU inside
  ONE 14-day window.
- **Blocked by.** **Heath, and this line is already established.** On 2026-09-09 he asked
  Cole to submit the applications and Cole declined — credit applications need his SSN,
  an income attestation and his signature consenting to a hard pull. He accepted. Docs he
  must pull himself: 10-day TFS payoff quote, dec page with VIN, VA award letter, DD-214,
  1099 / 2yr returns. Everything else is prepped.
- **Confidence.** inherited.

### BA9 — ~$818/yr of subscription cuts identified, none confirmed cancelled
- **What.** Cut list: HCTI $168, Xbox Game Pass + PS Plus $362 (duplicate), DroneMobile
  $128, Microsoft 365 vs Google One $100 (duplicate storage), Prime Video Ultra $60.
- **Evidence.** `heath-savings-sweep-2026-09.md`. HCTI is explicitly "already dropped
  from the plan, **still billing**" — and `feedback_video-only-no-static-cards` removes
  HCTI from the cost model entirely. He is paying $168/yr for a service the strategy no
  longer uses.
- **Effort.** Small — a few cancellation clicks each.
- **Blocked by.** Heath (account credentials, payment methods).
- **Confidence.** inherited.

### BA10 — The subscription sweep covered one inbox of three, and missed the expensive one
- **What.** The sweep read `heath.shepard@gmail.com` only. Zernio, Submagic, Creatomate,
  Pexels, fal.ai, Shotstack, DocuSeal, Resend, Hiscox E&O and all realtor dues bill to
  `heath@meetdossie.com` or `heath.shepard@kw.com`.
- **Evidence.** `heath-savings-sweep-2026-09.md`, "Coverage gap" — "zero hits here,
  **absence is NOT proof**. Next pass." It never happened.
- **Impact.** Unknown, and it's the inbox holding the business subscriptions. The sweep
  already proved CLAUDE.md understates ElevenLabs by $5/mo ($18.33 listed vs $23.45 on the
  August receipt), so **CLAUDE.md §2's $81.65 monthly fixed-cost total is wrong and has
  not been corrected.**
- **Effort.** Small.
- **Blocked by.** **agent** via the Gmail connector for `heath@meetdossie.com`. (kw.com is
  unreliable per RE21.)
- **Confidence.** the CLAUDE.md figures verified 2026-09-17; the sweep gap inherited.

### BA11 — 702 Fawndale had three non-payment cancellation notices in 2026; Easy Pay funding never verified
- **What.** Notices on 2026-02-18 and two on 2026-04-20. On Easy Pay since 2026-05-12, but
  nobody confirmed the funding account is good.
- **Evidence.** `heath-insurance-portfolio.md` action item 1.
- **Impact.** Compounds BA1. A lapse plus a mortgagee mismatch is exactly how the last
  force-placement happened.
- **Effort.** Small — one portal check.
- **Blocked by.** Heath (Allstate portal — and note the portal logged the Chrome extension
  out four times via Akamai bot detection, so this is a human-pace task).
- **Confidence.** inherited.

### BA12 — Two insurance replies outstanding, unchased since 2026-09-11 and 09-15
- **What.** (a) The Allstate records request — policy file, AP4970 full text, the date it
  was added to each policy, all material-change notices — mailed 2026-09-11.
  (b) Amy Sorensen's written answer on whether RCV applies to the **roof** specifically,
  given AP4970 expands what is depreciable, sent 2026-09-15.
- **Evidence.** `heath-insurance-portfolio.md`.
- **Impact.** AP4970 sits on all four rentals. This file already records one wrong
  high-confidence inference on exactly this point — the ACV claim was **wrong**, all four
  carry replacement cost — so it must be answered by the carrier, not inferred.
- **Effort.** Small.
- **Blocked by.** mixed — agent drafts, Heath sends. Per
  `feedback_surface-outstanding-replies-unprompted`, **the tracking itself is the agent's
  job and neither reply has been chased.**
- **Confidence.** inherited.

### BA13 — Script consolidation: correctly parked, trigger has not fired
- **What.** 669 `brokerage-*` scripts need collapsing; 142 are numbered one-click probes
  for a single zipForm transaction, and every new deal restarts at 01 rediscovering the
  same UI. Heath: *"park it but automatically pick it back up again so I don't forget
  after our policies."*
- **Evidence.** `script-consolidation-parked.md`; `jarvis_todos` row
  `fe750c05-938c-4e68-8b31-31180ef4d336`, still open.
- **Impact.** Not money, but real drag — **nothing in `_lib` uses `userDataDir` or
  `launchPersistentContext`**, so every script re-authenticates cold. Step 1
  (persistent-profile login) speeds up everything else.
- **Effort.** Small for step 1; multi-day for the full collapse.
- **Blocked by.** gated on the insurance work (BA1-BA12) finishing. Insurance is
  demonstrably not done, so **this stays parked.** Listed so the trigger isn't lost.
- **Confidence.** verified 2026-09-17.

### BA14 — Low Oak: $2,700 disbursement unconfirmed, rebate path undocumented
- **What.** Settled 2026-09-15 ($2,500 to seller, $2,700 back to buyers), all four
  signatures obtained, release and inspection report delivered.
- **Evidence.** `low-oak-earnest-money-dispute.md`; `jarvis_todos` "Low Oak — confirm
  Stewart Title refunds $2,700", still open.
- **Impact.** The $2,700 is the clients' money and Heath is who they'll ask. The
  future-commission rebate — Joe Sloan's approved path, deliberately never put in writing
  to the buyers — is his remaining goodwill obligation on a file where the clients said
  "we may take the legal route."
- **Effort.** Small — one call.
- **Blocked by.** **agent can poll** — but per
  `feedback_poll-system-of-record-not-notifications`, silence is not evidence of
  disbursement; it needs an affirmative check.
- **Confidence.** verified 2026-09-17 (todo open).

### BA15 — §11.22 veteran exemption is stranded on a zero-tax property
- **What.** His $10,000 §11.22 exemption (should be $12,000 at 100%) sits on the
  homestead, which already pays $0 under §11.131 — so it delivers nothing.
- **Evidence.** `heath-is-100-percent-disabled-veteran.md` — move it to a
  personally-titled property (2508 Via Anita, ~$272/yr) via Form 50-135. Neither §11.22
  nor §11.131 works on 130 Senisa; title is in the LLC and both require the veteran to own
  the property.
- **Impact.** ~$272/yr, recurring.
- **Effort.** Small — one Form 50-135.
- **Blocked by.** mixed — **agent can prepare the form**; Heath signs.
- **Confidence.** inherited.

### BA16 — Veteran-owned franchise tax exemption never filed for either LLC
- **What.** The five-year TX exemption for veteran-owned entities formed on/after
  2022-01-01 (Form 05-904 + a TVC letter). Dossie LLC and Rust Fitness App, LLC likely
  both qualify.
- **Evidence.** `heath-is-100-percent-disabled-veteran.md`.
- **Impact.** ~$0 cash under the no-tax-due threshold — **the benefit is dropping the
  annual PIR/OIR filings** for two entities.
- **Effort.** Small per entity.
- **Blocked by.** Heath (signature, VA documentation).
- **Confidence.** inherited, and flagged "likely," not confirmed. Note the same file
  **debunks** HB 235 and SB 524 — both died, do not act on them.

### BA17 — Free Texas Disabled Veteran Super Combo, ~$68/yr, never claimed
- **Evidence.** `pending-arkansas-fishing-license.md` — "~$68/yr of value he is not
  claiming. Remind him."
- **Effort.** Small — in person at any Academy/Walmart/TPWD office with VA proof dated
  within 12 months, or a TX DL bearing the Disabled Veteran designation.
- **Blocked by.** Heath (in person only).
- **Confidence.** inherited.

### BA18 — Arkansas fishing license, paused 2026-07-30, 50 days stale
- **What.** NT3 Nonresident 3-Day license, $30, decided but never purchased. Two questions
  still unanswered: the exact 3-day window (NT3 is non-transferable and non-refundable, so
  wrong dates burn the $30 — if dates aren't firm the $60 annual NRF is safer), and trout
  or not (the $20 Nonresident Trout Permit is legally required for the White River,
  Norfork and Little Red).
- **Evidence.** `pending-arkansas-fishing-license.md`.
- **Impact.** $30-80. Trivial money; listed as a clean example of a task that went silent
  for 50 days.
- **Effort.** Small.
- **Blocked by.** Heath (AGFC checkout hands to PayIt, which needs an emailed verification
  code and his card).
- **Confidence.** inherited.

### BA19 — DV plates never confirmed to be on the Tundra
- **What.** He has DV plates (DV02B46 zeroed a $60 parking charge on 2026-09-08), but
  nobody confirmed which vehicle carries them. One vehicle registers for a **$3 plate fee
  with all other registration fees waived** (Transp. Code §504.202).
- **Evidence.** `heath-is-100-percent-disabled-veteran.md`.
- **Effort.** Small.
- **Blocked by.** Heath.
- **Confidence.** inherited.

### BA20 — 130 Senisa loan renewal never confirmed
- **What.** The Sonora Bank loan hit 70 days matured/past due in June 2026 while Heath was
  overseas.
- **Evidence.** `heath-business-entities-and-contacts.md` — "Worth confirming it got
  renewed." A July 2026 loan extension document exists (loan 20000386), which suggests it
  was.
- **Impact.** Compounds BA5. Sonora has twice chased a lapsed cert on that property and the
  loan has been past due; **a lapse is a default trigger.** Banker: Jerrod Stallings,
  830-816-1405.
- **Effort.** Small — one call.
- **Blocked by.** Heath (banking relationship, identity verification).
- **Confidence.** inherited and **partially contradicted by the July extension doc —
  likely resolved. Verify before raising it with him.**

### BA21 — Liberty University Online Academy dispute, no owner, no deadline captured
- **What.** An unresolved dispute over his son's enrollment and a cancelled appeal.
- **Evidence.** `heath-business-entities-and-contacts.md`, "Watch items seen in the mail",
  recorded 2026-08-03 and never mentioned again in any file.
- **Impact.** Unknown — no dollar figure, no deadline. Six weeks untouched with no todo.
- **Effort.** Unknown.
- **Blocked by.** Heath.
- **Confidence.** inherited — **the thinnest entry in this document. Worth one clarifying
  question rather than action.**

---

## 6. THINGS THAT ARE CLOSED — DO NOT RE-OPEN

Verified today. Several are recorded as open in files an agent would read.

| Claim | Reality |
|---|---|
| Content engine shut down, 3 kill switches engaged | **Wrong.** All 49 `posting_schedule` rows active; FB, LinkedIn and Twitter posted 2026-09-17. |
| `meetdossie.com` has no Terms or Privacy Policy (`docs/TECH-DEBT.md`) | **Wrong.** `terms.html` and `privacy.html` exist, routed in `vercel.json`, both return 200. *(But both still render a "Draft pending attorney review" banner in production — see section 7.)* |
| Heath operating as sole prop, form a TX LLC urgently (`docs/TECH-DEBT.md`) | **Wrong.** Dossie LLC was filed with the TX SOS 2026-05-22. Heath corrected this on 2026-09-01. |
| `/founding` CTAs still live on marketing pages | **Fixed.** Only `ventures-webpage-analytics.html` references it. |
| Heath's realtor FB page blocked on an OAuth click | **Wrong.** Connected to Zernio 2026-08-18, `is_active=true`. See RE10. |
| `rustfitness.app` is NXDOMAIN and the #1 blocker on all Rust marketing | **Wrong.** Resolves, serves a real landing page. |
| Rust waitlist "not committed, not deployed" | **Wrong.** Tracked on `main`, `rustfitness.app/waitlist.html` returns 200. |
| Rust Paid Apps Agreement unsigned | **Signed** 2026-09-15. A `jarvis_todos` row still says otherwise. |
| `codemagic.yaml` has no `google_play:` block | **Wrong.** Line 398, added 2026-09-11. |
| Rust "no StoreKit IAP built" | **Wrong.** Landed 2026-09-16, commit `59b8f93`. It just can't activate — see RM4. |
| ACV roof exposure on the four rentals, $21-40k | **Does not exist.** All four already carry replacement cost; the carrier corrected this 2026-09-14. |
| §11.439 retroactive property-tax refund, up to $54,005.50 | **Dead.** The VA effective date doesn't predate 2025-07-03. `heath-is-100-percent-disabled-veteran.md` still presents it as open. |
| HB 235 veteran sales-tax exemption / SB 524 | **Both died in the legislature.** Debunked. |
| Biddle v. Disney settlement | **Missed.** Claim deadline was 2026-09-08. Money gone. |
| Cold email queue "fills but never drains" | **Wrong in that form.** It drained — 838 of 841. The real problem is the 33% bounce rate. See M12. |

---

## 7. RECORDS THAT ARE WRONG TODAY — FIX THESE FIRST

These generate wrong work every time an agent reads them. All are small, and all but
one are agent-doable unattended.

1. **`content-engine-shutdown-2026-07-12.md`** — describes a shutdown that has been
   reversed. Rewrite around the real failures (M1, M4, M9).
2. **`docs/TECH-DEBT.md` lines 34-35** — the LLC and ToS/Privacy entries are both false.
   Note the ToS/Privacy correction is only half: **both live pages still render "Draft
   pending attorney review" while 8 people pay against ToS §4's lifetime price lock.**
   That half is a real open item and needs Heath.
3. **`rust-app-store-submission-state.md`** (2026-08-31) — wrong on Paid Apps, codemagic,
   and IAP. Oldest and least reliable file in the Rust set.
4. **`heath-is-100-percent-disabled-veteran.md`** — still presents the §11.439 refund as
   open. Heath closed it.
5. **`docs/REALTOR-PAGE-CADENCE.md`** — claims an OAuth blocker that doesn't exist, and
   carries Nopalito at $1,295,000 (now $999,000) and Wild Cherry as active (closed
   2026-09-09). **Nothing should post from this doc until the prices are corrected.**
6. **`heath-real-estate-practice.md`** — its "Active listings (2026-08)" block is wrong on
   both entries. Real actives today: 23 Nopalito $999,000, 130 Senisa $389,000, 702
   Fawndale $330,000.
7. **`CLAUDE.md` §2** — the $81.65 monthly fixed-cost total understates ElevenLabs by
   $5/mo against an actual August receipt, and BA10 says the business inbox was never
   swept at all.
8. **`CLAUDE.md` §6 and §5** — say MRR $291 and 10 founding members. `docs/CUSTOMERS.md`
   says $204 and 8. The live table says 10 `active` rows, 2 of which cancel 2026-09-20.
   **And per G2 none of it is reconciled against Stripe.** Fix G2 before trusting any
   figure here.
9. **`kw-gmail-api-access.md`** — says the relevance watcher is dry-run only with
   `RELEVANCE_WATCHER_NOTIFY` unset. `relevance_watch_hits` has 95 rows `notified=true`,
   most recent 2026-09-17 04:00. It has been live for over three weeks.
10. **`jarvis_todos` "Log into zipForm"** (2026-09-10) — `zipform-credential-login.md`
    says SOLVED, and Pfeiffers e-sign traffic went out 2026-09-15. Close it.
11. **`jarvis_todos` "Create rust instagram"** — both Rust social todos are now partly
    satisfied (see RM6). Rescope to TikTok/YouTube.

---

## 8. NOTE FOR THE AUTONOMOUS LOOP

`docs/AUTONOMOUS-LOOP.md` lists ten signal sources. All ten are engineering-shaped —
support tickets, prod errors, KPI drift, `docs/TECH-DEBT.md`. **Nothing in this document
would ever be picked up by it**, which is precisely why these 59 items accumulated
unseen while the loop ran every four hours.

The 22 items marked `Blocked by: agent` are:
M2, M3, M8, M9, M10, M13, M14 · G11 · RE9, RE10, RE19, RE20, RE22, RE23 ·
RM3, RM16, RM17 · BA10, BA14 — plus RM18 and RM11 if a Bitwarden session is
available, and G9 if copy changes are pre-approved.

Two additions would close that gap:

1. **`alert_state` as a signal source.** M13 shows eleven conditions firing daily with no
   responder. The detection already works; only the routing is missing.
2. **This file as a signal source**, the same way `docs/TECH-DEBT.md` is — filtered to
   `Blocked by: agent`, which is the 17 items an unattended loop can actually finish.
