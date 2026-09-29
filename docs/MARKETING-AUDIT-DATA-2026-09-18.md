# Marketing Audit — Raw Data Pull

Pulled 2026-09-18 by Ridge (read-only). Source: live Supabase `pgwoitbdiyubjugwufhk` via service-role key
against `.env.local`, queried directly with `@supabase/supabase-js` (no caching, no MCP layer). Every number
below has its query attached. Where a figure comes from a memory file or `docs/CUSTOMERS.md` instead of a
live query, that is stated explicitly — those are marked **[DOC]**, not **[LIVE]**.

---

## 1. Customers — every paying subscription ever

**Query:** `select * from subscriptions order by created_at asc` (17 rows) + `select * from profiles` (29 rows,
cross-referenced on `user_id`) + `select * from founding_applications` (5 rows).

17 `subscriptions` rows split into three buckets:

| Bucket | Count | Rows |
|---|---|---|
| Real customers | 11 | Suzanne, Brittney, Tiffany, Kim, Miki, Cecilia, Terry, Amanda, Zelda, Natalie, Jennifer, Lisa — 12 names, 11 subscription rows (Tiffany's subscription record is one row) |
| Heath's own accounts (founder/test) | 5 | `f9644389`(heath.shepard@gmail.com, `is_founder=true`, status=cancelled), `60cb2a5f`/`f3787358`/`03435a90` (internal test, status="internal"), `0cd05e2f` (heath.shepard@kw.com, status="pending_onboarding", not paying) |
| Total rows | 17 | — |

**Every real customer, plan, start, status, acquisition source (`profiles.heard_from` / `founding_applications.heard_from`):**

| Name | Email | Sub created | Plan | Status (live) | Acquired via |
|---|---|---|---|---|---|
| Kay Suzanne Page | k.suzanne.page@gmail.com | 2026-05-01 | founding_friend ($1) | active | unknown — `heard_from` null |
| Brittney YBarbo | brittney@setxrealty.com | 2026-05-06 | founding ($29) | active | unknown in DB (`heard_from` null); `docs/CUSTOMERS.md` **[DOC]** says FB search "transaction coordinating in Texas" |
| Kimberly Herrera | kimberlyherrera@kw.com | 2026-05-19 | founding ($29) | active | unknown — `heard_from` null |
| Miki Mccarthy | mikirgvrealtor@gmail.com | 2026-05-20 | founding ($29) | active, `cancel_at_period_end=true`, `canceled_at` 2026-08-25, period ends 2026-09-20 | Facebook group: Ginger Unger |
| Cecilia Whitley | cecilia@sterlingassociatesre.com | 2026-05-20 | founding ($29) | active | unknown — `heard_from` null |
| Terry Katz | michellesellshouston@gmail.com | 2026-05-20 | founding ($29) | active | unknown — `heard_from` null (manual Stripe invoice backfill, webhook gap) |
| Amanda Nuckles | amanda@amandanuckles.com | 2026-05-20 | founding ($29) | active, `cancel_at_period_end=true`, `canceled_at` 2026-08-25, period ends 2026-09-20 | Facebook group (unspecified) |
| Zelda Cain | zelda@a2zrealestateconsultants.com | 2026-05-21 | founding ($29) | **cancelled** 2026-08-04 | Friend or colleague |
| Natalie Megerson | natalie@localchoicegroup.com | 2026-05-22 | founding ($29) | active | Facebook |
| Jennifer Beltrán | jenn.casamiateam@gmail.com | 2026-05-22 | founding ($29) | **cancelled** 2026-08-05 | Facebook (manual backfill, 2nd webhook gap) |
| Lisa Nilsson | lisanilssontx@gmail.com | 2026-05-28 | founding ($29) | active | Friend or colleague |
| Tiffany Gill-Teich | tgill@phyllisbrowning.com | DB row created 2026-06-09; Stripe period start 2026-05-16 | founding ($29) | active | unknown — `heard_from` null |

**Acquisition summary (from live data):** of 11 real customers, `heard_from` is populated for 6 (4 tag "Facebook"/"Facebook group", 2 tag "Friend or colleague"); 5 have no attribution value in `profiles.heard_from` at all. No paid channel, no cold-email conversion, and no `waitlist`/`calculator_signups` funnel conversion appears anywhere in this cohort.

**Last NEW paying customer:** Lisa Nilsson, subscription created **2026-05-28** — 113 days ago as of today (2026-09-18). Nobody has signed up since. Founding closed to new signups 2026-08-04 per CLAUDE.md §5, so this is expected, not a leak — but it also means every acquisition-channel question below is being asked of a cohort that stopped growing 3.5 months ago.

**Churn — who cancelled and when (`status='cancelled'` or `cancel_at_period_end=true`):**

| Name | Cancelled | Note |
|---|---|---|
| Zelda Cain | 2026-08-04 | Full cancel, had been flagged past-due (no dunning process) |
| Jennifer Beltrán | 2026-08-05 | Full cancel |
| Miki Mccarthy | 2026-08-25 (`canceled_at`) | Access continues to 2026-09-20 — **2 days from this report** |
| Amanda Nuckles | 2026-08-25 (`canceled_at`) | Access continues to 2026-09-20 — **2 days from this report** |

**4 of 11 real customers ever acquired (36%) have churned or are 2 days from churning.**

---

## 2. Post performance, last 90 days, all platforms — from `post_analytics` + `social_posts`

**Query:** `social_posts` full table (925 rows) + `post_analytics` full table (2,439 rows), paginated 1000/page,
joined on `social_posts.id = post_analytics.social_post_id`, latest snapshot per post taken by max `fetched_at`.

**Coverage — state this plainly, it's the headline of this section:**
- 925 `social_posts` rows total. Status breakdown (all-time): `posted`=501, `rejected`=357, `failed`=55, `approved`=5, `pending_video`=4, `draft`=2, `video_failed`=1.
- Of 501 posts with `status='posted'`, only **268 (53.5%) ever got a single `post_analytics` row.** 233 posted posts (46.5%) have **zero** analytics data, ever.
- 292 posts were posted in the last 90 days (`posted_at >= 2026-06-21`). Of those, **158 (54.1%) have any analytics; 134 (45.9%) have none.**
- `post_analytics` syncs on 16 distinct `sync_date` values from 2026-06-14 to 2026-09-13 — roughly weekly as documented, with two double-syncs (08-16/08-18, 09-12/09-13).
- **LinkedIn has a hard data gap: 99 LinkedIn posts (all-time, any age) show `views=0` on every single one** — the `views` field is not populated for LinkedIn by the Zernio sync at all, not "low," literally never set.

**Distribution stats, last-90-day posts with analytics, latest snapshot per post:**

| Platform | n (has analytics) | Views median / p90 / max | Likes median/p90/max | Comments median/p90/max |
|---|---|---|---|---|
| Facebook | 71 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| LinkedIn | 68 | 0 / 0 / 0 | 0 / 0 / 1 | 0 / 0 / 1 |
| Instagram | 19 | 1 / 2 / 5 | 0 / 0 / 0 | 0 / 0 / 0 |
| Twitter | 56 posted, **0 with analytics** | no data | no data | no data |
| TikTok | 1 posted, **0 with analytics** | no data | no data | no data |

All-time (any post age, not just last 90 days), for context: Facebook max views ever recorded = 168 (n=131 tracked posts, median still 0); Instagram max = 31 (n=44); LinkedIn max = 0 (n=99, confirms the field is dead for that platform).

**Top 5 posts by views, last 90 days (all from Instagram — the only platform with any nonzero views in-window):**
1. Views 5, likes 0 — hook_type `REAL_EXAMPLE` — "One of her own files just moved from Active Option to Pending -- a real Boerne listing, tracked start to finish..."
2. Views 2, likes 0 — hook_type `before_after` — "Last month: guessing. This month: verified. Texas option periods run from the execution date..."
3. Views 2, likes 0 — hook_type null — "One minute late and the buyer's right to terminate is gone. The option period in Texas runs from the executed contract..."
4. Views 2, likes 0 — hook_type null — "Who's tracking your earnest money deadline while you're at a showing? Here's the TREC rule..."
5. Views 2, likes 0 — hook_type `before_after` — "$15. Zero missing compliance docs. Compliance Vault tracks every required document type..."

**Bottom 5 (0 views, tied — LinkedIn, picked at random from the tie since hundreds share this value):**
1. hook_type `number` — "3 seats. 1 risk dashboard. That's what Dossie's Team Plan admin tools are built around..."
2. hook_type `bold_claim` — "Every missed follow-up has the same cause. No one queued it up before the day got busy..."
3. hook_type `story` — "One brief. Every deadline. Every morning. Dossie's morning brief runs through every active file..."
4. hook_type `story` — "Your pipeline should not live in your head. Most agents running 8-12 active files..."
5. hook_type `bold_claim` — "You don't need to trust the math. You need to see it. Every TREC deadline Dossie calculates..."

**Verdict: there is no meaningful "top vs bottom" signal here.** The entire distribution for Facebook and
LinkedIn is 0 at every percentile up to p90. The only platform with any measurable audience response
(Instagram) tops out at 5 views on a single post. This is not "which hook works" data — it's "the audience is
statistically zero" data.

---

## 3. Funnel — signups per month, 6 months, all sources

**Query:** `profiles` (29 rows, filtered to 18 by excluding `is_demo=true` and known QA/test email patterns —
excluded list printed below for auditability), `founding_applications` (5 rows), `waitlist` (3 rows),
`calculator_signups` (1 row).

Excluded as demo/QA/internal, not real funnel entries: `carter-verify-setpw-...@mailinator.com`,
`demo-team-tc@meetdossie.com`, `heath@meetdossie.com`, `carter-qa-...@meetdossie.com`,
`demo-team-agent1/2/3@meetdossie.com`, `demo2@meetdossie.com`, `demo-team-lead@meetdossie.com`,
`carter-qa-leadpaint-...@meetdossie-test.com`, `demo@meetdossie.com`. (This filtered list still includes
Heath's own personal/test @gmail.com founder accounts, which are not real prospects either — see Section 1.)

| Month | `profiles` created (filtered) | `founding_applications` | `waitlist` | `calculator_signups` |
|---|---|---|---|---|
| 2026-04 | 0 | 0 | 0 | 0 |
| 2026-05 | 13 | 3 | 1 | 1 |
| 2026-06 | 3 | 0 | 0 | 0 |
| 2026-07 | 0 | 1 | 1 | 0 |
| 2026-08 | 2 | 1 | 1 | 0 |
| 2026-09 (partial, to 9/18) | 0 | 0 | 0 | 0 |

**Total signups across all four tables, last 90 days (2026-06-21 to 2026-09-18): 5** — 3 `profiles` creations
(the demo-team seed rows already excluded, so this is genuinely thin), 2 `founding_applications` (one is a QA
test row, "Qa Test - Claude (Ignore)"), 1 `waitlist` row (also a QA test: `ridge-phaseD-calc-test@meetdossie.com`),
0 `calculator_signups`. **Net real, non-test signups in the last 90 days: at most 1-2, depending on how you
score the ambiguous QA rows.**

Demo requests, trials started, trial→paid: **unknown — no table or field tracks this.** There is no
`demo_requests` table, no `trial_started_at` column found on `profiles` or `subscriptions`, and `trial_end` on
`subscriptions` is null on every one of the 17 rows. If a trial concept exists in the product, it isn't
instrumented anywhere I can query.

**Attribution (`first_touch`/`last_touch`, shipped 9/17):** Both columns exist on `subscriptions` (17 rows) and
`founding_applications` (5 rows) — confirmed live via schema introspection. **Every single row, on both
tables, has `first_touch IS NULL` and `last_touch IS NULL`.** Zero rows populated. I also searched `api/` and
`scripts/` for any code path that writes to `first_touch` — none found. The columns shipped; nothing writes to
them yet. This isn't "one row, unattributed" — it's zero rows, unattributed, on a schema that's one day old.

---

## 4. Cold email — the 838 sends

**Live query:** `select * from email_events` (2,364 rows, paginated). No table named `cold_email_recipients`,
`cold_email_queue`, or `cold_email_campaigns` exists in this schema — those don't return errors, they return
`null`/not-found, confirmed via direct table probe. `email_queue` exists but has only 13 rows and is unrelated
(transactional, not the cold campaign). `campaign_id` and `batch_id` are `null` on every `email_events` row —
**this table cannot distinguish the cold-email campaign from transactional mail or from smoke-test rows**
(confirmed test rows present: `test@example.com`, `atlas-smoke@example.com`, `atlas+sarahbuyer@meetdossie.com`).

Live aggregate from `email_events`, all-time (2026-06-30 to 2026-09-18, includes test-row noise):
delivered=1,509, bounced=617, delayed=38, opened=188, clicked=12. **No `replied` or `meeting` event type
exists in this table's `event_type` enum at all** — replies and meetings booked are **unknown, not zero**:
there is no mechanism that would record either even if they happened.

For the actual campaign-level send count and per-domain bounce breakdown, this session relies on **[DOC]**
`cold-email-queue-fills-but-never-drains.md` (dated 2026-09-01, since this table has no campaign tagging to
recompute it live): 838 of 841 queued rows sent 2026-06-17 to 2026-08-27 across 5 campaigns
("6:47pm again?" x550, "$400 per file?" x150, "quick follow-up" x49, "the control freak problem" x42, "last
one from me" x42). Bounce breakdown by domain: jbgoodwin.com 338 bounced / 0 delivered (100% failure, guessed
addresses), phyllisbrowning.com 220 bounced / 308 delivered (42% failure), kw.com 4 bounced / 129 delivered
(97% fine). **Conversion: zero.** No subscription in the live `subscriptions` table has a `created_at` after
2026-05-28, and the cold-email sends started 2026-06-17 — after the last real signup, not before it. **838
sends, 0 replies tracked (untracked, not zero), 0 meetings tracked (untracked, not zero), 0 paying customers.**

---

## 5. Activity vs. outcome — posts published per month vs. new customers per month

**Query:** `social_posts` where `status='posted'`, grouped by month of `posted_at` and `platform`; new
customers per month from Section 1's real-customer `subscriptions.created_at`.

| Month | FB | Twitter | IG | LinkedIn | TikTok | Total posts | New paying customers |
|---|---|---|---|---|---|---|---|
| 2026-05 | 63 | 29 | 21 | 15 | 0 | 128 | 11 (all of them — Suzanne through Lisa) |
| 2026-06 | 57 | 61 | 21 | 29 | 0 | 168 | 0 (Tiffany's Stripe period-start was 05-16, DB row backfilled 06-09 — see Section 1 note) |
| 2026-07 | 21 | 5 | 30 | 17 | 0 | 73 | 0 |
| 2026-08 | 13 | 7 | 4 | 12 | 1 | 37 | 0 (2 cancellations instead) |
| 2026-09 (to 9/18) | 46 | 10 | 4 | 35 | 0 | 95 | 0 |

**Correlation, one sentence: posting volume ranges from 37 to 168 posts/month over the last five months while
new paying customers is 11-then-flat-zero for four straight months regardless of whether volume tripled or
dropped by 75% — there is no visible relationship between posting cadence and new-customer count in this
data**, and the only month with real acquisitions (May) also had the direct founding-application/warm-referral
channel open, which is a confound this data can't separate from the posting volume itself.

---

## 6. Cost vs. revenue

**Cost — [DOC], CLAUDE.md §2, not independently verified against a bank/card statement this session:**
Zernio $18 + ElevenLabs $18.33 + Submagic $12 + Hiscox E&O $33.32 = **$81.65/mo fixed.** (Vercel/Supabase/
Creatomate/HCTI-at-current-volume/Resend/Pexels/Stripe = $0 fixed per that doc.) Variable: Stripe
2.9%+$0.30/charge — on 7-9 active $29 charges that's roughly $6-8/mo, immaterial.

**Revenue — [LIVE], `subscriptions` table, today 2026-09-18:**
- Currently billing, no pending cancellation: Suzanne $1 + Brittney/Kim/Cecilia/Terry/Natalie/Lisa/Tiffany
  (7 x $29) = **$204/mo.**
- Plus Miki + Amanda, still billing through 2026-09-20 (2 days from this report) before their
  `cancel_at_period_end` takes effect: +$58/mo = **$262/mo total currently invoicing.**
- After 2026-09-20: MRR drops to **$204/mo** unless something changes in the next 48 hours.

**Cost vs. revenue: $81.65/mo fixed cost against $204-262/mo revenue — currently net-positive on fixed
marketing-stack cost alone**, before accounting for Heath's own time, the $838-send cold-email domain-
reputation risk (Section 4), or the fact that 0 of that revenue has been added net-new since 2026-05-28.

---

## Reconciliation note vs. CLAUDE.md / docs/CUSTOMERS.md

CLAUDE.md §6 currently states "MRR: $291/month... 10 founding @ $29 + Suzanne @ $1." That figure still
includes Miki and Amanda as full $29 actives — live data confirms both are `cancel_at_period_end=true`,
canceled 2026-08-25, dropping 2026-09-20. `docs/CUSTOMERS.md` already reflects the corrected $204 figure
(2026-08-24 entry) and matches this pull. **CLAUDE.md §6 is stale and should be corrected to $204 (dropping
further after 9/20)** — flagging for whoever owns that file next, not fixing it here (read-only audit).
