# Rust — Influencer / Affiliate Program

**Written 2026-09-16.** Every number below was read out of the Rust codebase
(`/mnt/c/Users/Heath/Projects/Rust`), the live endpoints, or a cited public source on
that date. Where a memory file disagrees with the code, the code wins and the
discrepancy is named.

---

## 0. The one-paragraph answer

**Referral codes do not exist and cannot be issued today.** There is no promo-code,
coupon, affiliate or referral table anywhere in the Rust repo, and the one live billing
path (Stripe Checkout, web only) is built without a promotion-code field. What *does*
work today is **first-touch UTM attribution** (already shipped, already writing to
`profiles` and `waitlist`) and **comped accounts** (a `subscriptions` row with
`status='active'` and no Stripe id — a first-class, already-exercised case). That is
enough to run a real pre-launch creator program. It is not enough to run a paid
affiliate program, and the gap is roughly one hour of work for the Stripe side and a
store release for the App Store / Play side.

**And a harder blocker than any of that: there is nowhere to send a creator's audience.**
`rustfitness.app` **does not resolve** — Google Public DNS returns NXDOMAIN for both A
and NS records against the `.app` TLD (checked 2026-09-16). The only live destination is
`https://rust-eight-rosy.vercel.app/waitlist.html` (HTTP 200, verified). You cannot put a
`vercel.app` URL in a creator's bio and expect either the creator or their audience to
treat it as a real company. **Buy and point the domain before the first DM goes out.**

---


---

## 0.1 What can run today vs. what waits for launch

| Capability | Today | Why |
|---|---|---|
| Build the target list | **✅ Run now** | Costs nothing, spends nothing |
| Genuinely engage with creators' content | **✅ Run now** | The highest-value thing available this week, and the only one that compounds |
| Offer a comped lifetime account | **✅ Run now** | One `subscriptions` row, `status='active'` — already an exercised pattern |
| Track a creator's traffic | **✅ Run now** | First-touch UTM → `profiles` / `waitlist`, already shipped |
| Capture the audience | **✅ Run now** | `waitlist.html` live (HTTP 200) + `POST /api/waitlist` validating, verified 2026-09-16 |
| Send people to a credible URL | **❌ Blocked** | `rustfitness.app` is NXDOMAIN. Only `rust-eight-rosy.vercel.app` resolves |
| Email creators from a Rust address | **❌ Blocked** | Public support contact is `heath.shepard@kw.com`, and kw.com inbound has been silently rejecting mail since 2026-09-10 |
| Issue a discount or referral code | **❌ Not built** | No promo/coupon/referral code anywhere in the repo; Checkout has no promotion-code field |
| Extend someone's free trial | **❌ Not built** | 7 days is set by a DB trigger; nothing can override it |
| Pay a creator a revenue share | **❌ Blocked** | Nothing is billing yet on mobile. Web Stripe works but nobody subscribes to a fitness app in a mobile browser |
| App Store promo / offer codes | **❌ Waits for launch** | Paid Apps Agreement signed 2026-09-15 (Processing); no subscription product exists; `purchases_enabled` defaults false |
| Google Play promo codes | **❌ Waits for launch** | 12 opted-in testers required, 4 opted in as of 2026-09-11 — the 14-day clock hasn't started |
| Pay a flat sponsorship fee | **⚠️ Possible, don't** | No measured conversion rate yet, so any flat fee is an unpriced bet (§1.5) |
## 1. Economics

### 1.1 What Rust actually charges — verified

| Fact | Value | Source |
|---|---|---|
| Price | **$19.99/month** | `src/lib/billing.ts` → `priceDisplay()` web fallback `{ amount: '$19.99', long: '/month' }`; commit `f1b2c27` *"refactor(billing): one purchase entry point + price to $19.99"* |
| Annual plan | **None.** `pickPackage()` prefers `current.monthly`; no annual SKU exists anywhere | `src/lib/billing.ts` |
| Native price | Whatever the store returns (`StoreOffer.priceString`) — **not** hardcoded | `src/lib/billing.ts` |
| Free trial | **7 days, no credit card required** | Set by the `create_trial_on_signup` Postgres trigger in Supabase `aflqnvlhpkbokfneyhqh`, referenced at `src/lib/auth.tsx:89` and `api/_lib/entitlement.ts:5`. ⚠️ The trigger body is **not** in tracked `migrations/` — the literal `7` is not readable from the repo. Heath's own signup on 2026-09-16 got 7 days; the app only ever reads `subscriptions.trial_end` |
| What gating looks like | `status='trialing'` until `trial_end` passes → `Paywall.tsx` | `src/lib/useSubscription.ts:106-130` |

**The card-less trial is the single most important number in this whole document.**
Rust does not collect a card at signup — the trigger grants the trial, the paywall appears
on day 8. A card-gated opt-out trial converts around **48.8%**; a no-card opt-in trial
converts around **18.2%** on average, and the honest percentile view is **4–6% at the
median, 10–15% at the 75th percentile**
([Kirro](https://kirro.io/free-trial-conversion-rate),
[Adapty trial benchmarks](https://adapty.io/blog/trial-conversion-rates-for-in-app-subscriptions/)).
A brand-new app with no reputation sits at the median, not the top quartile. **Every model
below uses 5–10%**, not the flattering number.

Two related facts worth designing around:
- Opt-in trials attract **3–4× more signups** than card-gated ones, so the top of Rust's
  funnel is unusually wide and the bottom unusually narrow. Creator traffic will look
  fantastic in signup counts and modest in revenue. Judge creators on **paid subs, never on
  signups.**
- **Users who don't complete at least 3 workouts in their first week churn at 4–5× the rate
  of those who do** ([Lifecycle Architect](https://lifecyclearchitect.com/benchmarks/fitness-apps-churn-rate-benchmarks/)).
  That is the single highest-leverage line to put in a creator's script: *"do three sessions
  in the first week or don't bother."* It costs nothing and it moves the number that every
  commission calculation multiplies by.

### 1.2 Net revenue per paying subscriber

| Path | Gross | Platform fee | **Net to Heath** | Live today? |
|---|---|---|---|---|
| Web — Stripe Checkout | $19.99 | 2.9% + $0.30 = $0.88 | **$19.11** | **Yes** |
| App Store, Small Business Program (<$1M/yr) | $19.99 | 15% = $3.00 | **$16.99** | No |
| Google Play, first $1M/yr | $19.99 | 15% = $3.00 | **$16.99** | No |
| Either store at standard rate | $19.99 | 30% = $6.00 | $13.99 | No |
| RevenueCat | — | $0 under $2,500/mo tracked revenue, 1% above | — | Shipped dark |

Rust qualifies for both reduced-rate programs (Apple's requires enrolment; Google's 15%
on the first $1M is automatic). **Model mobile at $17.00 net, web at $19.11.**

> Android will *never* route to Stripe. `src/lib/billing.ts` documents the reason in the
> code: Google Play's Payments policy requires Play billing for subscriptions and forbids
> pointing users at another payment method. So the $19.11 web margin is a web-only number,
> and mostly theoretical — almost nobody subscribes to a fitness app in a mobile browser.

### 1.3 The cost side everybody forgets: COGS per active user

| Component | Rate | Monthly, moderate user |
|---|---|---|
| Coach chat | `claude-haiku-4-5-20251001`, `max_tokens: 1500`, large system prompt + up to 2 tool rounds (`api/chat.ts:1428, 1454, 1462`) | ~$0.015–0.03/turn → **$1–3** |
| Coach voice | ElevenLabs `eleven_multilingual_v2` (`api/tts.ts:77`), ≈1 credit/char ≈ **$0.0006/char** on the Creator plan. A 400-char reply ≈ **$0.24** | 40 spoken replies → **$9.60** |

**⚠️ There is no per-user rate limit in `api/chat.ts` or `api/tts.ts`.** A heavy voice user
can cost more than the $17 they pay. This is not a hypothetical objection to the pricing —
it is a direct constraint on the promo design below: **a code that hands out 30 free days
hands out up to ~$10–12 of real cost per redeemer, not $0.** Free months are not free.

### 1.4 What a 10% recurring cut is actually worth

The funnel, with every assumption stated. Creator with **30,000 followers**, one dedicated
video plus two stories:

| Step | Rate used | Result |
|---|---|---|
| Views on the post | ~1/3 of followers (IG in-feed central case) | **10,000** |
| Views → link clicks | 1–3% | **100–300** |
| Clicks → account created (free, no card) | 15–25% | **20–70** |
| Signup → trial genuinely used | ~60% | 12–42 |
| Trial → paid, **no card on file** | 5–10% | **1–7** |

**Central case: 3 paying subscribers per creator post.**

| Metric | Value |
|---|---|
| 10% of gross | **$2.00** per sub per month |
| 10% of net ($17.00) | **$1.70** per sub per month |
| Creator's month-1 cheque, 3 subs | **$5.10 – $6.00** |
| Monthly churn | Fitness-app median **10–13%/mo**, top quartile 4–6% ([Lifecycle Architect](https://lifecyclearchitect.com/benchmarks/fitness-apps-churn-rate-benchmarks/), [Business of Apps](https://www.businessofapps.com/data/health-fitness-app-benchmarks/)); use **12%** |
| Implied average tenure | ~8 months |
| **Creator's lifetime earnings from that one post** | **~$41** |

### 1.5 Verdict: 10% recurring is not a deal

A 30k-follower creator's going rate for a dedicated post is **$150–$1,500** for an Instagram
feed post and **$200–$800** for a TikTok video in the 10k–100k tier, with Reels commanding
30–50% over static — and **health and fitness carries a 40–80% premium over the base rate**
([Influencer Marketing Hub](https://influencermarketinghub.com/influencer-rates/micro-influencer-rates/),
[InfluenceFlow 2026 benchmarks](https://influenceflow.io/resources/influencer-pricing-benchmarks-complete-2026-guide-to-creator-rates/),
[Hootsuite](https://blog.hootsuite.com/influencer-pricing/)). Call the realistic ask **$300–$800**.

**$41, paid out over eight months, arriving as a $5 first cheque**, is not remotely competitive
with that — and it is being offered by an app with no store listing, no users and no domain.
Nearly every mid-tier creator will pass, and the ones who don't will post once and never
mention it again, which is worse than a no.

Worse, the structure is backwards: the creator does all the work in week 1 and sees the
money spread across a year. Pre-launch, that asymmetry is the whole problem.

**What the offer has to be instead:**

| Deal | Creator earns (central case: 3 subs, 8-mo tenure) | Heath's cash risk | When to use it |
|---|---|---|---|
| 10% recurring | ~$41 lifetime | $0 | Only sub-10k creators, or someone who already uses the app |
| **30% recurring for 12 months** | **~$122 lifetime** | **$0** | **The pre-launch offer.** Competitive with a small flat fee, zero cash out |
| 50% of month 1 + 20% recurring | ~$30 up front + ~$82 | $0 | When a creator needs the cheque to feel real early |
| Flat $300/dedicated post (low end of the real market) | $300 | **$300 cash** | Post-launch only, and only after a link has proven a rate |
| Free lifetime account + 30% recurring | ~$122 + a comp | ~$4–10/mo COGS | **The only lever that works today.** The comp is the actual hook pre-launch |

**Break-even on a flat fee.** 3 subs × $17 net × 8 months = **$408 gross**, minus ~$4/mo
COGS × 3 subs × 8 months ($96) = **~$312 contribution**. Against a $300 market-rate post that
is a **loss**, and even a generous 6-sub outcome only gets to ~2:1. **A single sponsored post
at market rate does not pay for itself at a $19.99 price point with a card-less trial.** Do
not pay a flat fee until a creator's own link has produced a measured conversion rate — that
is the single most expensive mistake available in this whole program.

**The rate that makes 30% safe.** At 30% of gross, Heath pays $6.00/sub/mo against $17.00
net and ~$4 COGS — a contribution of **$7/sub/mo**, still positive, and it only ever pays
out on revenue that actually arrived. A revenue share cannot bankrupt you; a flat fee can.

### 1.6 Can we issue codes today? A line-by-line answer

| Mechanism | Exists today? | What it takes |
|---|---|---|
| **Stripe Checkout promo-code field** | **No.** `api/create-checkout.ts` builds the session with `mode`, `customer`, `line_items[0][price]`, `success_url`, `cancel_url`, `metadata[user_id]`. There is no `allow_promotion_codes`, no `discounts[...]`, no `subscription_data[trial_period_days]` | **One line.** Add `'allow_promotion_codes': 'true'` to the `URLSearchParams`, create Coupons + Promotion Codes in the Stripe dashboard. **~1 hour** including a real test purchase |
| **Attributing a redeemed code to a creator** | **No.** `api/stripe-webhook.ts` persists only `user_id`, `status`, `stripe_subscription_id`, `current_period_end`. The discount is never read | Read `discounts[0].promotion_code` off the subscription object in the webhook, persist it on the `subscriptions` row. **Migration + ~2–3 hours** |
| **Extended free trial via a code** | **No.** The 7 days come from the `create_trial_on_signup` DB trigger. Stripe coupons discount *money* — they cannot extend an app-side trial | A redeem endpoint that pushes `trial_end` out, or `subscription_data[trial_period_days]` at checkout. **~1 day** — and this is the option with real COGS (§1.3) |
| **App Store offer / promo codes** | **No.** Paid Apps Agreement was only signed **2026-09-15** (status "Processing", term Sep 15 2026 – Aug 15 2027); no subscription product is configured; `app_versions.purchases_enabled` defaults **false** and `VITE_REVENUECAT_IOS_API_KEY` gates it independently | Create the subscription product + an Introductory or Promotional Offer in App Store Connect, wire RevenueCat, flip the flag. **Days, and strictly downstream of the app actually releasing** |
| **Google Play promo codes** | **No.** Android is pre-production — Google requires **12 opted-in testers held 14 consecutive days**; as of 2026-09-11 there were 15 addresses on the list and **4 opted in**, so the 14-day clock has not started | Downstream of production release entirely |
| **UTM-link attribution** | **✅ YES — already shipped and working** | `src/lib/acquisition.ts` captures first-touch `utm_*` + referrer into `localStorage`; `src/lib/auth.tsx:98-120` writes them onto the `profiles` row at signup (migration `020_acquisition_tracking.sql`); `migrations/029_waitlist.sql` carries the same columns on `waitlist`. **Nothing to build** |
| **Comping a creator a free account** | **✅ YES** | A `subscriptions` row with `status='active'` and no `stripe_subscription_id` is a first-class case — `src/billing-harness.tsx:62` has a `comp` fixture, and it is exactly how the Apple reviewer account was set up. One service-role insert, **zero build** |

### 1.7 The verdict, stated plainly

> **Run v1 on UTM links and comped accounts. Not codes.**
>
> Pre-launch there is nothing to discount — the app is free for 7 days and then unbuyable
> on mobile. A code would be theatre. A UTM link measures the same thing, works today,
> and costs nothing.
>
> Build the Stripe promotion-code path (the one-line change plus webhook attribution,
> ~half a day total) in the same week the app actually goes live, not before. Build
> App Store offer codes only after there is a live subscription product earning money.

**What to promise a creator, in writing, today:** a tracked link, a comped lifetime
account, and **30% of net revenue for 12 months on every subscriber attributed to their
link**, paid monthly once the store billing exists — with the honest caveat that billing
is not live yet and the first cheque cannot arrive before launch. That last sentence is
not a weakness. Creators who have been burned by pre-launch apps respect being told the
truth about payout timing, and the ones who don't ask were never going to convert anyway.

---

## 2. Target list

### 2.1 How this list was built, and its limits

**Verification standard.** Every creator below was found through live web research on
2026-09-16 and each row carries the URL it came from. **Follower counts on social platforms
are not reliably readable without logging in, so any count that could not be confirmed
against a public source is labelled `unverified`.** Treat every number as a magnitude, not a
measurement — check the profile yourself before you send anything. A creator who has gone
quiet, changed handle, or tripled in size since this was written is the normal case, not the
exception, and **step 1 of §4.2 is re-verifying every row.**

**Why micro and mid tier.** The brief is right and the economics in §1.4 prove it: at a
$19.99 price point with a card-less trial, a mega-creator's post cannot pay for itself.
What actually converts is a creator whose audience believes they personally train the way
the app programs. **The target band is roughly 5k–150k**, and inside that band engagement
rate matters far more than reach — a creator with 50k followers at 12% engagement charges
2–3× one with 50k at 3%, and is worth considerably more than that premium
([Influencer Marketing Hub](https://influencermarketinghub.com/influencer-rates/micro-influencer-rates/)).

**Who Rust actually serves**, and therefore the four niches this list covers:

| Niche | Why it fits the product |
|---|---|
| **Strength / barbell / powerlifting** | The progression logic *is* the product: hit your reps → +5 lb, miss badly → −10%. That's a barbell lifter's language, not a general-fitness one |
| **Recovery, readiness, HRV, sleep** | The readiness check before every session is the single most differentiated thing Rust does, and this audience already believes in the premise |
| **Over-35 / masters lifters** | The people whose day-to-day capacity genuinely varies — the exact reason the feature exists, and the exact reason Heath built it |
| **Hybrid, home-gym, tactical, veteran** | The 121-item equipment catalog programs around whatever you actually own; the veteran angle is real and aligned (framing rules in `docs/RUST-PRELAUNCH-MARKETING-PLAN.md` §5) |
| **Fitness-app / fitness-tech reviewers** | Disproportionate leverage for a launch. Their audience arrives already shopping for an app, and a review is a format they publish anyway |

**Screening applied to every candidate** (full disqualifier table in §5.4): supplement-code
pushers, crash-diet or sub-1200-calorie content, medical claims, body-shaming, and
engagement-pod patterns are excluded on principle, not on taste. Each is flagged in the
`Risk` column where it applies. The reason is not squeamishness: **Rust's own coach is
hard-coded to refuse supplement dosing, medical diagnoses, aggressive deficits and any
comment on a user's body.** A creator whose whole channel is built on what the product
refuses to do will produce an audience that churns in week one.

**How to use the table.** Copy it into a sheet and add these columns before anything else:
`verified (y/n) · followers checked on · DM sent · date · replied · comped · posted · UTM link · paid subs`.
The last column is the only one that matters, and §4.2 forbids approaching more than five
people before it has a number in it.

### 2.2 Strength / powerlifting / barbell

Counts marked **[IG 9/16]** were read off the live Instagram profile on 2026-09-16.
**[Modash 9/13]** = Modash's public directory, last updated 2026-09-13, which also supplies
engagement rate and fake-follower estimate.

| # | Handle | Platform | Followers | Engagement | What they post | Already promotes? | Why Rust | Risk |
|---|---|---|---|---|---|---|---|---|
| 1 | [@bign8nrg](https://www.instagram.com/bign8nrg/) (Nathaniel Neill) | IG | 33.4k [IG 9/16] | ER 2.24%, 14.3% fake [Modash 9/13] | Powerlifting coaching, squat/DL technique reels, Orlando FL. Co-founder @anstrengthservices | **Yes** — code `NRG` for @110percent | Sells 1:1 coaching; Rust is the scalable version of what he already sells. Auto-progression is literally his pitch | Low — light supplement tagging |
| 2 | [@iron_beard_strength](https://www.instagram.com/iron_beard_strength/) (Coach Mario) | IG | 28.6k [IG 9/16] | ER 2.61% [Modash 9/13] | "THE Mediocre Powerlifter" — comedy + coaching, Stan.store merch | **Yes** — `IRONBEARD10` codes | Self-deprecating everyman voice, ideal for over-35 non-elite lifters. Already runs code mechanics | ⚠️ Med — smelling-salts/supplement codes. No medical claims seen |
| 3 | [@itsmikehuberrr](https://www.instagram.com/itsmikehuberrr/) (Michael Huber) | IG | 47.7k [IG 9/16] | **ER 6.65%**, 17.6% fake [Modash 9/13] | USAF veteran, WRPF national record holder, 712 lb DL | None evidenced | **Best engagement-to-size ratio in the strength set.** Veteran/military audience skewing 30-45 — overlaps Heath's own story | Low |
| 4 | [@huntfitness](https://www.instagram.com/huntfitness/) (Kyle Hunt, MEd, CSCS) | IG + podcast | 13.5k [IG 9/16] | unverified | Powerbuilding coaching, author, host of *The Kyle Hunt Show* (since 2016) | Own books + coaching; podcast carries sponsor reads | **Top-5 approach.** Dad, 15+ years coaching, and the podcast is a *second* inventory channel a DM can't buy | Low |
| 5 | [@thestrengthathlete](https://www.instagram.com/thestrengthathlete/) | IG | 13.8k [IG 9/16] | unverified | Team account for TSA online powerlifting coaching | Own coaching service | Coach-side partner — the "TC scaling clients" analogue | ⚠️ May read Rust as competitive |
| 6 | [@luckylifts](https://www.instagram.com/luckylifts/) (Alex Luckow) | IG | 7,422 [IG 9/16] | **ER 14.65%**, 16.5% fake [Modash 9/13] | Powerlifting coaching | **Yes** — @110percent code `lucky` in bio | Extraordinary ER for the size, and already an affiliate operator so the ask is a familiar motion | Low |
| 7 | [@soph.squats](https://www.instagram.com/soph.squats/) (Dr. Sophia Veiras) | IG | 7,497 [IG 9/16] | ER 2.44%, 14.7% fake [Modash 9/13] | Barbell physical therapist, USAPL, women's powerlifting | PT/coach at Peak Collaborative | Readiness + soreness check-in is native to her content | ⚠️ **PT = medical-adjacent.** Brief her on the medical-boundaries guardrail (§5.2.3) before anything goes out |
| 8 | [@jake_amendola](https://www.instagram.com/jake_amendola/) | IG | 5,849 [IG 9/16] | **ER 7.52%, 9.27% fake — cleanest audience found** [Modash 9/13] | Powerlifting, Neptune Beach FL | SBD apparel athlete | Small, but the most genuinely real audience on this list. Cheap first test slot | Low |
| 9 | [@eric_obc](https://www.instagram.com/eric_obc/) (Eric LaPointe) | IG | 5,739 [IG 9/16] | ER 3.28% [Modash 9/13] | Full-time coach, '22 Raw Nats champ, owner Odyssey Barbell Club, USAPL chair | **Yes** — SBD affiliate, @pr_breaker code | Gym-owner physical distribution *plus* proven affiliate behaviour | Low |
| 10 | [@strength_analytics](https://www.instagram.com/strength_analytics/) (Henry Tosh) | IG | 5,120 [IG 9/16] | ER 1.05%, 10.8% fake [Modash 9/13] | British Powerlifting Head Coach 2018-23, owner Super Training Gym UK. Data-led strength content | Own coaching | **Ideologically the closest fit on the whole list** — he sells data-driven lifting, which is Rust's entire thesis | Low, but weak ER. Treat as a credibility borrow, not reach |
| 11 | [@coach_wodyn](https://www.instagram.com/coach_wodyn/) (Andrzej Roszkowski) | IG + YT | 19.7k [IG 9/16] | ER 1.18%, 21.7% fake [Modash 9/13] | All-time world-record powerlifter; **bio says "45 year old"**; YouTube educator | Poliquin-certified coaching | Bridges strength and masters — an elite masters lifter who teaches | ⚠️ Poliquin lineage sometimes carries supplement/hormone-adjacent claims. Read recent posts before approaching |
| 12 | Alexander Bromley — [YouTube](https://www.boostcamp.app/coaches/alex-bromley) / Empire Barbell | YouTube | ~75k subs per a Jan 2026 Boostcamp profile — **current count unverified**; **IG handle not confirmed** (`@alexanderbromley` is a dead 5-follower account, not him) | unverified | Strongman/powerlifting program design, author of *Base Strength*, Base Strength Podcast | Sells books + the BASE app | Program-design credibility with the "job and a family" crowd | 🚫 **Has his own training app** — likely competitive conflict |

### 2.3 Recovery / readiness / HRV / sleep

| # | Handle | Platform | Followers | What they post | Already promotes? | Why Rust | Risk |
|---|---|---|---|---|---|---|---|
| 13 | [@altini_marco](https://www.instagram.com/altini_marco/) (Dr. Marco Altini) | IG, Substack, X | 6,241 [IG 9/16] | HRV science, training readiness, wearable-data critique. PhD data science, 50+ papers | **Yes, structurally** — founder of HRV4Training, **advisor to Oura**, lecturer at VU Amsterdam | **The single best credibility fit for the readiness check.** If he validates Rust's readiness logic that's a moat, not a post | ⚠️ Owns a competing HRV app + Oura advisory. **Approach as a paid technical advisor, not an affiliate** — see §2.6 |
| 14 | [@drmiketnelson](https://www.instagram.com/drmiketnelson/) (Dr. Mike T Nelson) | IG (verified) | 12.6k [IG 9/16] | Metabolic flexibility, **HRV-guided training**, autonomic nervous system. CSCS, CISSN, associate professor, creator of the Flex Diet Cert | **Yes** — sells his own certifications; frequent podcast guest | Has taught HRV-guided autoregulation for a decade. Audience is coaches plus serious 35+ lifters | Low. Evidence-based, no crash dieting |
| 15 | [@drbubbs](https://www.instagram.com/drbubbs/) (Dr. Marc Bubbs) | IG + Performance Nutrition Podcast | 11.8k [IG 9/16] | Performance nutrition, sleep, recovery. Consultant to Canada Basketball, fmr Atlanta Hawks/Penguins. Author of *Peak* and ***PEAK40*** | Co-founder @probionutrition; own books/podcast | **Spans recovery and over-40 perfectly** — *PEAK40* is literally the midlife readiness thesis. Podcast is second inventory | ⚠️ Nutrition credentials — screen for supplement and health-claim language. **Note:** `@dr_bubbs` is a different person with 70 followers |
| 16 | [@sleep4sport](https://www.instagram.com/sleep4sport/) (Dr. Amy M. Bender, PhD) | IG + X | 3,696 [IG 9/16] | Evidence-based sleep for athletes. Clinical Program Director, Centre for Sleep & Human Performance; adjunct prof U. Calgary; works with the Canadian Olympic team | None evidenced | Smallest on the list and the most credentialed authority on sleep-for-performance — exactly Rust's daily sleep input | ⚠️ Clinical sleep role. Keep messaging to performance; **never** sleep-disorder treatment |

### 2.4 Over-35 / masters / hybrid

| # | Handle | Platform | Followers | What they post | Already promotes? | Why Rust | Risk |
|---|---|---|---|---|---|---|---|
| 17 | [@garagegymathlete](https://www.instagram.com/garagegymathlete/) (Jerred Moon) | IG | 33.7k [IG 9/16] | "Strength & conditioning for the everyday athlete. Trainable anywhere: your garage, a gym, or the road" | **Runs his own app** | Audience is dead-centre Rust: 30-50, garage gym, equipment-constrained — which the 121-item catalog exists to solve | 🚫 **Direct competitor.** Affiliate unlikely. Value here is competitive study, or a podcast sponsor buy |
| 18 | [@andrewcoatesfitness](https://www.instagram.com/andrewcoatesfitness/) (Andrew Coates) | IG | 163k [IG 9/16] | Writes for Men's Health, T-Nation, Muscle & Fitness; hosts *Lift Free and Diet Hard*; trainer at Evolve Strength South. Anti-misinformation, pro-sustainable lifting | **Yes** — tags @rpstrength; paid partnership work is his business model | Top of the allowed band. Enormous industry credibility; a nod from him de-risks Rust with coaches | ⚠️ **Over the 150k band** — most expensive slot here, and the RP association is adjacent to a competing app ecosystem |
| 19 | [@katerh_fitness](https://www.instagram.com/katerh_fitness/) (Kate Rowe-Ham) | IG (verified) | 105k [IG 9/16] | "Midlife & Longevity Strength Coach." Author, podcaster, BBC/Netflix/Times/Telegraph | Own app (Owning Your Menopause) + book | Strongest single voice for women 40+ who lift | ⚠️ Menopause framing edges toward medical, **and she runs a competing app.** Medical-boundaries brief required |
| 20 | [@fit_over_50_](https://www.instagram.com/fit_over_50_/) | IG | 32.4k [IG 9/16] | Community/aggregator — inspiration and information reposts for the 50+ segment | None evidenced | Cheap reach into 50+; aggregator accounts usually take flat-fee posts | ⚠️ Repost account, not a coach — **low authority, verify it isn't bot-inflated before paying anything** |
| 21 | [@kennethpiercejr](https://www.instagram.com/kennethpiercejr/) (Kenneth Pierce) | IG | 25.2k [IG 9/16] | Hybrid athlete, Austin TX. "Yes I run, no I didn't lose my gains." 3× marathon (3:37 PR), HYROX | Listed on **Collabstr** — already transacting with brands | Hybrid-athlete segment, and readiness/soreness is a genuine pain point when you run and lift. **Texas-based** | Low |
| 22 | @jasminfitover40 (Jasmin) | IG | **5.2k — Collabstr-reported, could NOT be confirmed on IG. Verify first** | 47-year-old weightlifter. "Realistic strength training, gym education, humor and confidence with women over 40." Lost 70 lbs | Bookable via Collabstr | Real over-40 practitioner voice, cheap, bookable through a marketplace | ⚠️ The 70 lb weight-loss story means her copy must be screened so Rust is not pulled into weight-loss claims |

### 2.5 Fitness-app reviewers, home gym, hybrid/tactical, veteran

All YouTube subscriber counts in this section were read off the **live channel page HTML on
2026-09-16**, not from a third-party estimator. "Last upload" is from the same fetch.

**App reviewers are the highest-leverage group in this entire document** — their audience
arrives already shopping for a training app, and a review is a format they publish anyway,
so the ask is "will you look at this" rather than "will you advertise for me."

| # | Handle | Subs (9/16) | Last upload | What they post | Already promotes? | Why Rust | Risk |
|---|---|---|---|---|---|---|---|
| 23 | [@helloochen](https://www.youtube.com/@helloochen) | **7.18k** | 3 days | Recurring *"is this the best fitness app"* format + Garmin/Fitbit. Recent: Boostcamp review, LiftTrack review, *"I Tested 8 Fitness Apps"*, *"MacroFactor — Is It Worth $99?"* | **None found — whether he takes paid promos is unverified** | **Best pure-play app reviewer in range.** Readiness + auto-progression is exactly his beat; his wearable coverage means a sleep/energy input lands in familiar territory | Low |
| 24 | [@IronOathFitness](https://www.youtube.com/@IronOathFitness) (Ryan O'Connor, CSCS, MS) | **9.82k** | 5 days | Wearables and health-tech long-term reviews. *"I Replaced My Whoop With the Garmin Cirqa"*, *"I Tracked My Sleep for 7 Years"* | `thorne.com/u/ironoath` storefront; runs the *Iron Oath Weekly* podcast | Sleep/readiness is his core topic | ⚠️ **Thorne supplement affiliate, and promotes Function Health blood testing ("can save your life") — medical-claim adjacent.** §5.4 |
| 25 | [@strengthsweatsucceed](https://www.youtube.com/@strengthsweatsucceed) | **11.3k** | 3 days | Strength-focused gear + tech, "after N weeks" format. Suunto, Hume Band, Garmin | Amazon (×6), Ultrahuman, Kineon. **Bio lists a partnerships address** | Openly commercial, strength-first, trivially easy to transact with | ⚠️ Kineon red-light-therapy affiliate leans device-efficacy claims |
| 26 | [@Aesthetic_Al](https://www.youtube.com/@Aesthetic_Al) | **43.9k** | 1 month | *"Tech reviews for the fitness enthusiast"* — watches, headphones, endurance tech | **`join.runna.com/…/refer` — a live fitness-APP referral link** | Proven app-affiliate mechanics, which most of this list lacks | Low. ⚠️ Skews endurance over strength; cadence has slowed |
| 27 | [@HomeGymGains](https://www.youtube.com/@HomeGymGains) (Kevin) | **2.39k** | **9 hours** | Home-gym dad in Japan; equipment + gym-app reviews. *"Don't Pay for a Gym App Until You Watch This — Boostcamp Exposed"* | **Ancore affiliate ID + a Welling app referral link** | Crossover home-gym × app-review. Already makes the exact video Rust wants to be in | Low |
| 28 | [@AJFaithFitness](https://www.youtube.com/@AJFaithFitness) | **1.3k** | recent | Bio: *"here to help you find the right apps & tools to track your progress."* Strong vs Hevy comparisons | None found — unverified | Tiny but 100% on-thesis. Cheap test | Low |
| 29 | [@garagegymreviewseverything](https://www.youtube.com/@garagegymreviewseverything) (Lindsay Scheele) | **21.6k** | 11 days | Reviews everything fitness incl. tech and apps; runs *"Guide to 2026's Best Fitness Apps"* roundups | GGR link shortener | Editorial authority | ⚠️ **Owned by Garage Gym Reviews** — a deal routes through their brand-partnership team, priced like media, not like a creator DM |
| 30 | [@daltoncharacky](https://www.youtube.com/@daltoncharacky) | **1.38k** | recent | *"Dieting \| App & Food Reviews."* *"Out of 35 Fitness Apps, This One Is The Best"* | None found — unverified | Does head-to-head app rankings | ⚠️ **Weight-loss-first framing** — vet the diet content against §5.4 before any association |
| 31 | [@RileyHastings](https://www.youtube.com/@RileyHastings) | **3.28k** | 4 days | Home gym + tech, high production quality | — | — | 🚫 **DO NOT APPROACH. He shipped his own workout app (RankXP) and is documenting the build.** Listed only so nobody adds him later |
| 32 | [@LukesGarageGym](https://www.youtube.com/@LukesGarageGym) | **8.88k** | **2 days** | *"I review home gym equipment so you don't waste money on junk… tested hundreds of pieces of gear."* Racks, cable machines, benches | Own site; **no supplement affiliates, no competing app** | **Cleanest fit on the entire list.** The 121-item equipment catalog is a demo built for his exact format | Low |
| 33 | [@NoFate247](https://www.youtube.com/@NoFate247) (Jonathan) | **30.7k** | **1 day** | *"Helping everyday lifters and home gym enthusiasts train smarter."* Reviews REP, RitFit, Major Fitness — **and published "Best Free Gym App in 2026"** | Equipment affiliates | Crossover home-gym × app-review at real scale | Low |
| 34 | [@GlucksGym](https://www.youtube.com/@GlucksGym) | **128k** | 6 days | Two decades of experience; PRx, Rogue, REP reviews. Also did *"The Best Free Workout App — Boostcamp Review"* | **Full affiliate shortener (`gluck.fit/…`)** across dozens of products | Real scale with proven affiliate infrastructure | ⚠️ **Top of the band — stretch tier.** Expect media pricing |
| 35 | [@InfiniteGrit](https://www.youtube.com/@InfiniteGrit) (Jon Hamilton) | **78.5k** | **1 day** | Bio: *"a collective of Green Berets and strength and conditioning coaches."* *"How to Build a Body That Can Handle Running, Rucking and Lifting"* | **Proven — `otbboots.co/infinitegrit`** plus a coaching application funnel | Hybrid + veteran in one, at scale | ⚠️ Sells his own coaching (partial conflict). **The Green Beret claim is self-reported in the bio and was not independently verified** — see the caveat below |
| 36 | [@ModernAthleteStrength](https://www.youtube.com/@ModernAthleteStrength) | **9.48k** | **16 hours** | Pure tactical-athlete programming: work-capacity circuits, "Warfighter Cycle", neck training, EDT | Sells via TrainHeroic + own site | **Serious, low-hype, programming-literate — the audience most likely to actually value auto-progression.** Posts daily | Mild conflict: sells programming |
| 37 | [@everydayheroesfitness](https://www.youtube.com/@everydayheroesfitness) (Mitch Gourley) | **60.2k** | 4 days | *"I help firefighters lose weight, eliminate pain & regain strength."* Ex-firefighter, runs live first-responder events | Coaching funnel | First-responder niche at scale | ⚠️ **Transparent Labs supplement affiliate + weight-loss-transformation framing + "eliminate pain" copy.** Two §5.4 flags |
| 38 | [@doclyssfitness](https://www.youtube.com/@doclyssfitness) (Dr. Alyssa Olenick, PhD) | **43.2k** | 12 days | *"Science-backed hybrid running, cardio, hyrox and lifting."* Recent: *"The PERFECT Hybrid Training Split"*, *"Exposing The BIGGEST Electrolyte Myth"*, *"Does Creatine Timing Actually Matter?"* | — | **Lowest medical-claims risk found anywhere on this list — she actively debunks.** The best available credibility shield for an AI-coaching product | Low |
| 39 | [@Koachknussi](https://www.youtube.com/@Koachknussi) (Justin Knussi) | **7.61k** | 3 days | HYROX / hybrid week-of-training content | Represented by an agency, so already monetizing | Hybrid segment | ⚠️ Thin public info — treat anything beyond subs and recency as unverified |

**Awareness only, do not approach:** [@SOFLETE](https://www.youtube.com/@SOFLETE) (43.5k,
uploads daily, genuinely technical tactical content) — but it is a **brand that sells its own
programming**, so it is a competitor, not an affiliate.

**Flagged and rejected on the veteran angle:** [@thenaturaledge](https://www.youtube.com/@thenaturaledge)
(61.1k) claims Special Forces service, but the bio opens with a combat-lesson-to-business hook
and the links push a UTM-tracked lead funnel. **This is the "sells the uniform" pattern — not
recommended.** Also dropped: @theruckshow1, whose name is the creator's surname (Rucker) and
whose content is bodybuilding, not rucking or veteran anything.

> ### ⚠️ Stolen-valor caveat — read before any veteran-angle partnership
>
> Every service claim in this section is **self-reported in a channel bio**. The accounts, the
> subscriber counts and the content were verified. **No DD-214 was verified, and none can be
> from the outside.** Heath is a 100% disabled veteran and that fact is genuinely load-bearing
> in Rust's founder story. Attaching it publicly to someone whose service turns out to be
> fabricated is not a recoverable mistake. **Verify off-platform, in a conversation, before any
> veteran framing goes public with both names on it.**

**Dead or dormant — do not spend outreach on these:** @garagegymlab (21.1k, silent 2 years),
@struckbyluck (15.7k, 2 years), @BudgetGymCo-op (73.3k, 7 months), @SOFPrepCoach (50.9k,
6 months), @jtperformance_ (18k, 2 months), @KnowledgeByMarcus (39.6k, 8 months — **and it
isn't a fitness channel at all**; recent uploads are Square inventory and retirement
calculators). @ColinHJS (52.9k) — last-upload date could not be resolved, recency unverified.

**Handles that returned no channel:** `@StewSmithFitness`, `@TacticalBarbell`,
`@FirefighterFunctionalFitness`, `@FireRescueFitness`. Stew Smith and Fire Rescue Fitness are
real operations with real websites — **treat these as unverified handles, not as nonexistent
people.**

**Too big, aspirational only:** @GarageGymReviews (693k) · @coachdango (692k) · @Dcrainmaker
(650k) · @MichaelEckert (575k) · @SOCOMAthlete (571k) · @TheQuantifiedScientist (413k) ·
@GrittySoldier (403k) · @DesFit (284k) · @ChasetheSummit (190k) · @jtmnavy (148k).
**In range but stacked:** @KevTheTrainer (85.1k) — 16 Amazon links, a Legion supplement code,
and a Planet Fitness ambassadorship. He'd transact readily, and Rust would be one message
among many.

### 2.6 Rejected, and why — read this before adding anyone yourself

The rejections are more instructive than the list. Six of these look perfect at a glance.

| Who | Why not |
|---|---|
| [@thefitover40man](https://www.instagram.com/thefitover40man/) (Nick Conaway) | 390k [IG 9/16]. Too big — aspirational only. *(Search snippets said 366k; the live page said 390k. Treat every cached number as stale.)* |
| [@jailhousestrong](https://www.instagram.com/jailhousestrong/) (Josh Bryant) | 248k [IG 9/16]. Too big |
| @coachjoeljamieson | ~114k, unverified. **Founder of Morpheus** — a direct competitor readiness/recovery product. Hard conflict |
| [@drkristenholmes](https://www.instagram.com/drkristenholmes/) | 135k [IG 9/16]. Global Head of Human Performance at **WHOOP**. Outstanding content, unusable as an affiliate |
| @kylecolver | 106.9k, but **30.71% ER against 19.3% fake followers and an 86.6% female audience on a powerlifting account** [Modash 9/13]. That is a looks-driven audience, not buyers of a training app |
| @louisksmith | 31.5k with **33.5% fake followers** and 1.37% ER [Modash 9/13]. Worst audience quality found |
| @drcharlieseltzer | 119.7k. Board-certified **obesity physician** — Rust's medical-boundaries guardrail makes this a non-starter (§5.4) |
| @_thelastbarbender | 5.3k, but a bio-level supplement affiliate (`@tier1supplements` code) [Modash 9/13]. Disqualified under §5.4 |
| @melanie.diamor.fit | 32.1k with strong reach, but her breakout content is about **narcolepsy and invisible disability**. Sleep + medical + a readiness app is precisely the association Rust must avoid |
| [@40fitradio](https://www.40fit.com/40fitradio/) | Only **737 IG followers** [IG 9/16] despite a well-known masters podcast (Dr. Darin Deaton, DPT, Starting Strength Coach). **Not an IG play — but the podcast itself is a real sponsorship target** for the over-40 slice |
| @barbell_empowered · @shailafitness · @dr_bubbs · @sleepisaskill · @thatfitfriend · @alexanderbromley · @challenger_st · @40fit | Checked and rejected as wrong or dead handles. `@dr_bubbs` is a **different person** with 70 followers; `@alexanderbromley` is a dead 5-follower account; `@thatfitfriend` returned 3 followers. **These are exactly the traps that produce a fake-looking target list** — every one of them would have passed a plausibility check and failed on contact |

### 2.7 Two patterns that change how you use this list

**1. The fake-follower baseline in strength content is 15-22%.** Only four accounts came in
materially cleaner — @jake_amendola (9.3%), @strength_analytics (10.8%), @soph.squats (14.7%),
@bign8nrg (14.3%). Weight those up, and assume roughly a fifth of any headline number here
is not a person.

**2. Competitor overlap — not supplements — is the dominant risk in the recovery niche.**
The three most credible readiness voices alive all work for competing products: Altini
(HRV4Training, Oura), Jamieson (Morpheus), Holmes (WHOOP). And in the masters/home-gym
niche, Jerred Moon and Kate Rowe-Ham both ship their own apps.

> **The move that follows from this:** approach Marco Altini as a **paid technical advisor
> who validates the readiness logic**, not as an affiliate. "Will you tell me whether my
> readiness model is defensible" is a question he can say yes to without a conflict, it's a
> question almost nobody asks him, and a credible yes is worth more to Rust than any single
> post on this list. That is a different and probably better deal than the one this document
> was asked to design.

### 2.8 The five to approach first — and the order

39 creators are listed above. **§4.2 forbids approaching more than five before a reply comes
back.** These are the five, in send order, with the reason each one is in this position rather
than a bigger name.

| Order | Who | Size | Why this one, and why now |
|---|---|---|---|
| **1** | [@HomeGymGains](https://www.youtube.com/@HomeGymGains) | 2.39k | **The pressure test, deliberately sent first.** Uploads daily, already runs tracked affiliate links, and has already published *"Don't Pay for a Gym App Until You Watch This."* At 2.39k the ask is small and the turnaround fast. **Use him to find out whether the pitch works before spending it on anyone who matters.** A flop here costs nothing |
| **2** | [@LukesGarageGym](https://www.youtube.com/@LukesGarageGym) | 8.88k | **The cleanest fit on the whole list.** Reviews equipment exclusively, "tested hundreds of pieces of gear," posts every 2-3 days. Rust's 121-item catalog is a demo built for his exact format: *here's my rack, my bands, one adjustable bench — watch it program around that.* No competing app, no supplement affiliate, no medical exposure, and small enough that he reads his own email |
| **3** | [@helloochen](https://www.youtube.com/@helloochen) | 7.18k | **The strongest app-review beat in range.** His recurring format is literally "is this the best fitness app," and he has covered Boostcamp, LiftTrack, MacroFactor and Hevy. His wearable coverage means a daily sleep/energy/soreness input lands somewhere his audience already cares. ⚠️ **No affiliate or discount code exists anywhere on his channel — whether he takes paid promos is unverified. The first message asks, it does not assume** |
| **4** | [@itsmikehuberrr](https://www.instagram.com/itsmikehuberrr/) | 47.7k | **The best engagement-to-size ratio in the strength set (6.65% ER).** USAF veteran, WRPF national record holder, 712 lb deadlift, audience skewing 30-45. The veteran overlap with Heath's own story is real and needs no embellishment — and per §2.5's caveat, it is a claim to confirm in conversation, not to publish on |
| **5** | [@huntfitness](https://www.instagram.com/huntfitness/) | 13.5k | **The only one who brings a second channel a DM can't buy.** MEd, CSCS, 15+ years coaching, dad, and host of a podcast running since 2016 with real sponsor inventory. If the app lands with him, there are two placements, and the podcast one reaches people while they are literally training |

**Swap rules:**
- If the veteran angle becomes the priority over raw app-launch leverage, swap #3 for
  [@ModernAthleteStrength](https://www.youtube.com/@ModernAthleteStrength) (9.48k, uploads
  daily) — tactical programming, zero hype, and an audience that will actually understand what
  automatic progressive-overload adjustment means.
- If none of the five reply within two weeks, **the message is the problem, not the list.**
  Change one thing in the DM and send the next five. Do not send fifteen.

**The separate, better deal — run it in parallel, it is not one of the five.**
[@altini_marco](https://www.instagram.com/altini_marco/) (Dr. Marco Altini, HRV4Training,
Oura advisor) is approached as a **paid technical advisor who reviews whether Rust's readiness
model is defensible** — not as an affiliate, which his own product would preclude. It is a
question almost nobody asks him, he can say yes to it without a conflict, and a credible yes
is worth more to Rust than any single post on this list.

---

## 3. The pitch

### 3.0 The rule that governs every word below

**Rust has ~5 users and they are all friends Heath texted the link to** (Jeffrey McPherson,
"Josh", "Bdub", "Bruke", plus Heath). There is no traction, no waitlist volume, no
testimonials, no revenue. Creators check. A fabricated "we're growing fast" gets you
blocked and, in this niche, screenshotted.

Everything below leads with what is *actually* interesting — six real AI coaches with six
real voices, and a founder who built it because every app he paid for ignored that his
capacity changes day to day. That story does not need a user count.

**Never say, in any version:** a number of users, a growth rate, "thousands of people,"
"launching soon on the App Store" as a promise with a date, any before/after, any health
outcome claim, or that the app "fixes," "treats," "prevents" or "diagnoses" anything.

### 3.1 The DM — the version that actually gets sent

Short enough to read in the notification preview. No link in the first message on
Instagram (links in a cold DM route straight to Requests and suppress delivery).

> **Hey [First name] — I built an AI strength coach called Rust. Six coaches, six actual
> voices, and it asks how you slept before it programs your session.**
>
> **Not in the app stores yet, so I'm not asking you to post anything. I'd just like to
> give you a free lifetime account and hear what you'd change.**
>
> **Want me to set one up?**

Three sentences. It asks for a reply, not a favour. The offer costs Heath a database row
(§1.6) and it is the only thing he has pre-launch that a creator actually values.

**Follow-up, only after they say yes and have used it for a week or two:**

> **Glad it's useful. When it does hit the stores I'd like to do something real with you —
> tracked link, 30% of what your people pay, for a year. No obligation either way, and I'd
> rather hear what's still broken first.**

**Variants for the three cases you'll actually hit:**

- *They already promote another app:* `Hey [Name] — saw you use [App]. I built one that does the part it doesn't: it asks how you slept and how sore you are before it writes the session, and the coach talks back in a real voice. Not in the stores yet. Want a free lifetime account to pick apart?`
- *Recovery / readiness creator:* `Hey [Name] — your [specific post] is basically the thing I built an app around. Mine takes a 1-to-5 on sleep, energy and soreness before every session and the coach programs off it. Not launched yet. Can I give you a free account?`
- *Veteran / tactical creator:* `Hey [Name] — I'm a disabled vet and I built a strength app because my capacity changes day to day and nothing I paid for cared. It asks before it programs. Not in the stores yet — want a free lifetime account?`

### 3.2 The email — longer, for anyone with a business address in their bio

Subject: **Free lifetime account, no ask**

> Hey [First name],
>
> I built an AI strength coaching app called Rust. Six coaches with six genuinely
> different voices, and it asks you for sleep, energy and soreness on a 1-to-5 before it
> programs the session — then the coach actually talks to you about the load.
>
> It's not in the App Store or Play Store yet, so there's nothing for you to link to and
> I'm not asking you to post anything. I'd just like to give you a free lifetime account
> and hear what you'd change about it. I'd rather find out what's wrong from someone who
> coaches for a living than from a review after launch.
>
> If it turns out you like it and you want to do something once it launches, I'd do a
> tracked link and 30% of what your people pay for a year. Totally separate conversation
> and genuinely not the reason I'm writing.
>
> Want me to set an account up?
>
> Thanks,
> Heath

**Notes on the voice** (per `heath-email-voice-profile.md`): `Hey [First name],` opener,
`Thanks,` closer, three short paragraphs, no bullet list, no bolding, no "I hope this
finds you well," no "excited to," no adjective stack. The commercial offer is deliberately
demoted to the second-to-last paragraph and explicitly disclaimed, which is both true and
the reason it will land.

**Signature — do NOT use his standing block.** `heath-email-voice-profile.md` records his
signature as *Riparian Asset Management, LLC* with the 808 number — that is his real-estate
**investor** identity and it does not belong on a fitness app pitch. Sign `Heath` plus
whatever the Rust support address ends up being.

### 3.3 The support address problem — fix before any email goes out

`Rust/public/support.html` hardcodes **`heath.shepard@kw.com`** — his Keller Williams
brokerage address — as the app's public support contact. Emailing fitness creators from a
licensed REALTOR's brokerage account is brand-confusing, and a non-real-estate commercial
product running through a KW address is exactly the compliance question Heath does not want
asked. Move it to `support@` / `heath@` at the Rust domain (ImprovMX forwards free, same
setup MeetDossie already runs). Also note `kw.com` inbound mail has been silently rejecting
since 2026-09-10 and is unresolved — a creator's reply could simply vanish.

### 3.4 One-page pitch deck — outline

One page. PDF. Sent only *after* a creator replies, never attached to a cold email.

| Block | Content | The rule |
|---|---|---|
| **1. Header** | `Rust — an AI strength coach that asks how you slept.` Logo (`public/logo-master.png`), the dark theme from `src/lib/theme.ts` | One line. No tagline stack |
| **2. What it is** | Six AI coaches — Marcus the powerlifter, Kira the athlete, Dev the scientist, Val the commander, Sage the guide, Rico the hype man — each with their own real ElevenLabs voice, not one voice with a filter. You talk, it talks back. | Six named characters is the whole hook. Lead with it |
| **3. Why an AI coach isn't a program PDF** | **A PDF can't answer.** Three concrete, code-true proofs: (a) *readiness* — three 1-to-5 sliders plus a 12-area soreness picker before every session, fed into the coach's context; (b) *progression that runs itself* — hit your target reps, it adds 5 lb; miss them badly, it takes 10% off; (c) *it remembers* — injuries, preferences and goals persist between conversations. | Every claim here is verifiable in `src/components/ReadinessCheck.tsx`, `src/pages/Workout.tsx:341-351`, and the `coach_memory` table. **Do not add a fourth** |
| **4. It programs around your actual gym** | 121 equipment items across 10 categories, one-tap presets for commercial / home / garage / bodyweight. | Count it in `src/constants/equipmentCatalog.ts` before every use — this number has shipped wrong before |
| **5. What your audience gets** | 7 days free, no card. $19.99/month after. Plus whatever extended-trial or discount offer exists at the time — **and if none exists yet, this block says so** | Never promise a discount that §1.6 says can't be issued |
| **6. What you get** | A tracked link, a free lifetime account, 30% of net revenue from your subscribers for 12 months, monthly payout, a live dashboard of your own numbers, and no exclusivity | Exclusivity is worth nothing to Heath and costs the creator real money. Don't ask for it |
| **7. Where it stands, honestly** | iOS submitted and in Apple's queue; Android held up by a Google-side scanner reading a stale manifest. No user count, because there isn't one worth quoting. | **This slide is the differentiator.** It is what separates this from the twelve other pre-launch app DMs in their inbox |
| **8. Who built it** | Heath, solo. Built it because his own capacity varies day to day and every app he paid for ignored that. | Per `docs/RUST-PRELAUNCH-MARKETING-PLAN.md` §5, the veteran fact is **never a credential** — it explains a product decision, it does not claim expertise. Final call on framing is always Heath's |

**Do not build this until three or more creators have replied.** A deck with nobody to
send it to is the most seductive form of procrastination available in this entire project.

---

## 4. Sequencing

### 4.1 The classic mistake, named so it can be avoided

**Pitching 40 creators cold with no product is the failure mode**, and it is the default
one because a target list *feels* like progress. It fails four ways at once, and all four
are live right now:

1. **Nowhere to send anyone.** `rustfitness.app` is NXDOMAIN; the only live page is a
   `vercel.app` URL. A creator who clicks it once will not click again.
2. **Nothing to pay with.** No codes, no store billing, no proven conversion rate (§1.6).
   A revenue-share promise you cannot yet honour reads as vapour to anyone who has been
   pitched before.
3. **One shot per creator, spent.** A creator who ignores a cold pitch for a pre-launch
   app will ignore the launch-day one too. **The list is a depleting asset.** Forty cold
   DMs this week destroys forty warm approaches in October.
4. **No signal to learn from.** Forty simultaneous pitches with no tracking tells you
   nothing about which message, niche or coach persona works. Five sequential ones do.

**The rule: never approach more than 5 creators before a previous batch has replied.**

### 4.2 This week — pre-launch (what can genuinely start now)

| # | Action | Owner | Blocks |
|---|---|---|---|
| 1 | **Buy the domain and point it at the `rust` Vercel project.** ~$15–20/yr, ~10 minutes | **Heath** | **Everything below** |
| 2 | Move the support address off `@kw.com` (§3.3) | **Heath** | Any email outreach |
| 3 | **Already done — verify only.** `waitlist.html` is live (HTTP 200) and `POST /api/waitlist` validates (400 on an empty payload), both confirmed 2026-09-16 on `rust-eight-rosy.vercel.app`. It just needs the real domain in front of it | Carter/Atlas | Attribution |
| 4 | **Build the list.** Take the §2 table, verify each handle is still live, drop anyone who's gone quiet, and put it in a sheet with columns: handle, platform, followers, link sent, date, reply, account comped, posted | Cole/Sage | Sequencing |
| 5 | **Warm up. This is the week's real work.** Pick the top 10. Follow them. Leave genuine, specific comments — reply to the *content*, never mention Rust. Two to three weeks of this before any of them get a DM | **Heath** | Reply rate |
| 6 | Mint the UTM links now: `?utm_source=creator&utm_medium=influencer&utm_campaign=<handle>`. Works today, zero build (§1.6) | Cole | Measurement |
| 7 | **Approach 3–5 only.** The early-access, no-ask DM (§3.1). Pick the ones with the strongest genuine fit, not the biggest | **Heath** | Learning |
| 8 | Comp every creator who says yes — `subscriptions` row, `status='active'`, far-future `current_period_end` (§1.6) | Atlas | Their actual usage |
| 9 | Recruit Android testers from the same conversations. Google needs **12 opted in, held 14 consecutive days**; 4 were opted in as of 2026-09-11. **A creator who opts in is worth more than a creator who posts right now** | **Heath** | The Android launch date |
| 10 | Email the Planet Fitness manager who gave Heath an address for in-gym materials — still not acted on, and it's warmer than any creator on the list | **Heath** | Nothing. Just do it |

**What explicitly does NOT happen this week:** no revenue-share contracts, no flat fees, no
promo codes, no pitch deck, no bulk outreach, no posting about a launch date nobody controls.

### 4.3 The 2–6 week middle — while iOS sits in Apple's queue

- Batches of 5. Send, wait a week, read the reply rate, change one thing, send the next 5.
- Track reply rate by niche. If readiness creators reply at 40% and general lifting at 5%,
  the whole list gets re-weighted — that's the point of going slowly.
- Anyone who comps in and actually trains with the app becomes a **development partner**,
  not a promoter. Ask what's broken. Ship one of their fixes and tell them you did.
  A creator whose feature request shipped will post unprompted; that post is worth ten paid ones.
- **Ship the Stripe promotion-code path** (`allow_promotion_codes` + webhook attribution,
  ~half a day, §1.6) so codes exist the day billing does.
- Keep building the `waitlist` list. Every creator link should land on the waitlist page
  with its UTM attached, so the value of each creator is measurable *before* billing exists.

### 4.4 At launch

1. **Day 0 — the people who already have the app** get a message first: *it's live, here's
   your link, here's the deal.* They've used it for weeks. Their post will be specific and
   true, which is the only kind that converts.
2. **Day 0 — turn codes on.** Stripe promotion codes live, plus an App Store offer code once
   the subscription product exists. One code per creator, matching their handle.
3. **Weeks 1–2 — measure, don't scale.** Let the first 5 links run. Compute the real
   click → signup → trial → paid rate and replace every assumption in §1.4 with a measured
   number. **Do not sign a flat-fee deal before this exists.**
4. **Weeks 3+ — scale the shape that worked.** Only then approach the rest of the list, and
   only then consider paying cash — and only to creators whose measured rate beats the
   break-even in §1.5.
5. **Post-launch, the offer changes.** Once there's a store link, a real conversion rate and
   actual users, the pitch stops being "free account, tell me what's broken" and becomes a
   normal affiliate offer. The early cohort keeps 30% — grandfathering them is cheap and it
   is what makes them advocates instead of vendors.

### 4.5 The honest alternative

If Heath does not have 6–10 hours a week for months — and he is running a brokerage
practice, Dossie and Sawyer — **the better play is to skip the creator program entirely
for now** and spend the same effort on: (a) the 12 Android testers, which is a hard launch
blocker, and (b) the Planet Fitness in-gym channel, which is warm, physical, and free.
A half-run creator program that pitches 20 people and follows up with none burns the list
permanently. Running none costs nothing.

---

## 5. Legal and compliance

### 5.1 FTC — what the law actually requires

The FTC's **Endorsement Guides** (16 CFR Part 255, revised June 2023) require that any
**material connection** between an endorser and a marketer be disclosed **clearly and
conspicuously**. The **Rule on the Use of Consumer Reviews and Testimonials** (16 CFR
Part 465, effective October 2024) made a subset of this conduct subject to **civil
penalties**, not just injunctions — undisclosed insider reviews and incentivised reviews
presented as independent are now directly penalisable.

**A material connection exists — and must be disclosed — for all of these:**

| Connection | Present in this program? |
|---|---|
| Cash payment, flat fee, ongoing sponsorship | Only if a flat fee is ever paid (§1.5) |
| Affiliate commission / revenue share | **Yes — the 30%** |
| Free product or service, including a free account or extended trial | **Yes — the comped lifetime account.** This one is routinely missed |
| Perks, trips, gifts | No |
| Employment, ownership, partnership | No |
| Personal or family relationship | **Yes for the existing ~5 friend users** if any of them post |

> **The comped account alone triggers disclosure, even with zero money changing hands, and
> even if the creator posts entirely on their own initiative.** This is the single most
> common way small brands get caught. Every creator who receives a free lifetime account
> discloses — no exceptions, including the ones who "just really like it."

**What a compliant disclosure looks like in 2026.** Enforcement has moved from *does a
disclosure exist* to *would an average viewer notice it immediately*:

- **Acceptable:** `#ad`, `#sponsored`, `Paid partnership with Rust`, or a spoken/on-screen
  line — *"Rust gave me a free account and pays me if you subscribe."*
- **Not acceptable:** `#collab`, `#partner`, `#sp`, `#thanksRust`, a hashtag buried at the
  end of a caption behind "…more", a disclosure only in a bio, a platform's built-in
  paid-partnership tag *on its own*, or a disclosure that appears only after the CTA.
- **Video specifically:** the disclosure must be **both spoken and on screen**, near the
  start, and must survive the viewer never expanding the caption. A Reel or TikTok where
  the only disclosure is in the caption does not comply.
- **Live / Stories:** repeat it — a viewer joining mid-stream must still see it.
- **AI-generated or AI-assisted endorsement content** is explicitly in scope; the FTC has
  signalled that content simulating a real opinion carries the same disclosure duty.

### 5.2 What Heath must require of every creator, in writing

A one-page agreement, countersigned before the first post. Non-negotiable clauses:

1. **Disclosure.** Creator will clearly and conspicuously disclose the material connection
   in every post, story, video, livestream and repost, per the FTC Endorsement Guides —
   spoken *and* on screen for video, and not only in the caption or bio. Non-compliant
   posts must be corrected or removed within 48 hours of notice; commission is withheld on
   a post that stays non-compliant.
2. **Honest-experience clause.** Creator will only claim what they have personally
   experienced. No invented results, no fabricated timelines, no reviewing a feature they
   have not used.
3. **No health or medical claims.** Creator will not state or imply that Rust diagnoses,
   treats, cures, prevents or manages any medical condition or injury, and will not present
   the AI coach as a substitute for a physician, physical therapist or registered dietitian.
   **Rust's own coach is hard-coded to refuse exactly this** (`api/chat.ts` MEDICAL
   BOUNDARIES: never diagnose, never recommend medication or supplement dosing, never give
   individualised medical nutrition therapy, defer the moment a condition or medication is
   named). A creator making a claim the product itself refuses to make is both a legal
   exposure and a direct contradiction of the app.
4. **No disordered-eating or crash-diet framing.** No promoting Rust alongside extreme
   deficits, "clean/dirty" food language, detoxes, or rapid weight-loss claims.
   Rust's nutrition guardrails hard-refuse calorie targets under 1,200/day and forbid the
   coach from pushing a deficit beyond 500–750 kcal below maintenance or commenting on a
   user's body. Same principle as (3): **the creator cannot promise what the product refuses.**
5. **No results guarantees.** No "you'll gain X lbs of muscle," no timeline promises, no
   income claims about the affiliate program itself.
6. **Accuracy of product claims.** Creator will not claim Rust does something it does not.
   Supply them a one-page fact sheet of verified capabilities. **Three known-false claims
   currently circulating in `marketing/rust-hook-library.md` must never reach a creator:**
   automatic calendar deload weeks (hooks #20 and #35 — no week counter exists anywhere in
   the codebase) and a 1-to-10 readiness slider that auto-rewrites the workout (hooks #11
   and #15 — the slider is **1-to-5** and the coach *advises*, it does not silently rewrite
   the session).

   > ⚠️ **Still unfixed as of 2026-09-16, and this is the dangerous part:** the same false
   > claims sit in `marketing/rust-hook-library.md` **line 5**, inside the block headed
   > *"What Rust actually is, for reference"* — "backs off on missed reps, **deload every
   > 5th week**" and "the coach **adjusts load, swaps exercises, rewrites the session**."
   > That block reads exactly like a fact sheet. If anyone hands it to a creator, the
   > creator will state fabricated capabilities on camera in good faith, with a disclosed
   > material connection — which converts a content error into an FTC deceptive-claims
   > problem that lands on **Heath**, not the creator. **Fix line 5 and hooks #11/#15/#20/#35
   > before a single creator sees any part of that file.**
7. **Store status.** Creator will not state or imply Rust is available for download until
   it actually is. Pre-launch, the only permitted CTA is the waitlist.
8. **Approval on first post only.** Heath reviews the first post before it goes live — for
   factual accuracy and disclosure, not for edits to their voice. After that, trust.
9. **Payment terms in writing.** Rate, basis (**net revenue actually collected**, after
   platform fees and after refunds/chargebacks — say this explicitly, it is the single most
   common affiliate dispute), duration, attribution window, payout schedule, and what
   happens to commission if the creator stops posting (nothing — it keeps paying).
10. **Termination.** Either side, 30 days, in writing. Commission on already-attributed
    subscribers survives termination. Say so — it is what makes the deal credible.
11. **Platform rules.** Creator is responsible for their own platform's branded-content
    disclosure tooling and for any advertising rules specific to their jurisdiction.

### 5.3 Heath's own exposure

- **The brand is liable too.** Under the Endorsement Guides an advertiser is responsible
  for its endorsers' deceptive claims and for failures to disclose. "The creator posted it,
  not me" is not a defence — monitoring is an obligation, not a courtesy. Practically: read
  every post, keep a screenshot of each one and the date, and log the disclosure.
- **Heath's own posts need disclosure too** when he is not obviously the owner — an
  ownership interest is a material connection. On his personal accounts, "I built this" is
  itself the disclosure, and it is cleaner than any hashtag.
- **Not legal advice.** This is a practitioner's summary. Before the first signed
  agreement, have the one-page creator contract reviewed — Hadley can draft it, and a real
  attorney should see it if any flat fees are ever paid.

### 5.4 Who is disqualified, regardless of reach

Screen every candidate against these before they go on the outreach list:

| Disqualifier | Why |
|---|---|
| Heavy supplement selling, especially with a code | Rust's coach **refuses** supplement dosing advice. An audience primed to buy dosing protocols is being sold a product that will decline to give them any |
| Crash-diet, detox, "1200-calorie what-I-eat-in-a-day," rapid-loss content | Directly contradicts §5.2(4) and the app's own hard 1,200 kcal floor |
| Medical or quasi-medical claims — "fixes your back pain," "cures tendinitis," "heals your shoulder" | Rust's guardrail forbids naming a diagnosis. Association imports exactly the risk the product was built to avoid |
| Body-shaming, transformation-shaming, or scale-focused "accountability" | Contradicts the app's explicit nutrition tone rules (never comment on body composition, no streaks on food) |
| Engagement-pod or bought-follower patterns | You will pay for traffic that does not convert, and §1.4 has no room for it |
| PED-forward content presented as normal training | Medical-claim and brand risk, and the programming logic doesn't serve that audience honestly |
| Stolen-valor-adjacent or unverifiable service claims | Heath's own veteran status is real and the framing rules are strict. Association with a fake one is unrecoverable |

---

## 6. The seven things that have to be true before this program works

In order. Nothing below #1 matters until #1 is done.

| # | Thing | State today | Owner |
|---|---|---|---|
| 1 | A real domain resolving to the waitlist | **`rustfitness.app` is NXDOMAIN.** Only `rust-eight-rosy.vercel.app` resolves | **Heath**, ~10 min |
| 2 | A support address that isn't `@kw.com` | `public/support.html` hardcodes `heath.shepard@kw.com`; kw.com inbound has been silently rejecting mail since 2026-09-10 | **Heath** |
| 3 | Rust social accounts to engage from | None exist. Heath cannot "warm up" on creators' content from an account that doesn't exist — his personal account is the honest interim answer, and arguably the better one | **Heath** |
| 4 | The false claims removed from the hook library | `marketing/rust-hook-library.md` line 5 + hooks #11/#15/#20/#35 still state capabilities the code does not have (§5.2) | Sage |
| 5 | A verified list with 5 people warmed up | This document is the list. The warming is not done | Heath / Cole |
| 6 | Stripe promotion codes + webhook attribution | Not built. ~half a day (§1.6). Do it the week billing goes live, not before | Carter |
| 7 | A store listing to link to | iOS in Apple's queue; Android needs 12 opted-in testers (4 as of 2026-09-11) | Apple / Google / Heath |

**Items 1–5 are free and can all be done this week. Items 6–7 wait for launch.** That split
is the whole answer to "what can run today."

---

## 7. What is deliberately NOT in this plan

- **No cold bulk outreach.** §4.1. The list is a depleting asset.
- **No flat fees before a measured conversion rate.** §1.5 shows a market-rate sponsored
  post loses money on the central case.
- **No promo codes built pre-launch.** There is nothing to discount yet.
- **No pitch deck until three creators have replied.** §3.4.
- **No exclusivity clauses.** Worth nothing to Heath, expensive for the creator.
- **No invented traction, ever.** Rust has ~5 users, all friends. Creators check, and in
  this niche a caught exaggeration gets screenshotted.
- **No before/after content.** Heath has none and must not fake one. The honest version is
  already hook #34: *"I'm not going to show you a before/after. I'm going to show you the
  coach adjusting my actual workout."*

---

## 8. Sources

- Rust codebase, `/mnt/c/Users/Heath/Projects/Rust`, read 2026-09-16: `src/lib/billing.ts`,
  `api/create-checkout.ts`, `api/stripe-webhook.ts`, `api/chat.ts`, `api/tts.ts`,
  `src/lib/useSubscription.ts`, `src/lib/auth.tsx`, `src/lib/acquisition.ts`,
  `src/components/Paywall.tsx`, `src/billing-harness.tsx`, `migrations/020`, `migrations/029`.
- Live checks 2026-09-16: Google Public DNS (`rustfitness.app` → NXDOMAIN, A and NS);
  `https://rust-eight-rosy.vercel.app/waitlist.html` → HTTP 200;
  `POST /api/waitlist` with an empty body → HTTP 400.
- `docs/RUST-PRELAUNCH-MARKETING-PLAN.md`, `docs/CONTENT-FORMAT-LIBRARY.md` §4,
  `marketing/rust-hook-library.md` (MeetDossie repo).
- Memory: `rust-app-store-submission-state`, `rust-apple-support-case-2026-09-11`
  (Paid Apps Agreement signed 2026-09-15), `play-console-tester-list-traps`
  (4 of 12 testers opted in, 2026-09-11), `rust-fitness-vercel-project`,
  `rust-feature-backlog`, `heath-email-voice-profile`.
- [FTC's Endorsement Guides: What People Are Asking](https://www.ftc.gov/business-guidance/resources/ftcs-endorsement-guides-what-people-are-asking) — FTC
- [FTC Disclosure Rules for Influencers, 2026](https://thesocialmedialawfirm.com/blog/influencer-law/what-are-ftc-disclosure-rules-for-influencers-in-2026-complete-guide-examples/) — The Social Media Law Firm
- [Micro Influencer Rates for 2026](https://influencermarketinghub.com/influencer-rates/micro-influencer-rates/) — Influencer Marketing Hub
- [Influencer Pricing Benchmarks 2026](https://influenceflow.io/resources/influencer-pricing-benchmarks-complete-2026-guide-to-creator-rates/) — InfluenceFlow
- [Influencer rates: how to maximize your budget in 2026](https://blog.hootsuite.com/influencer-pricing/) — Hootsuite
- [Free Trial Conversion Rate: 8-25% No Card, 30-60% With](https://kirro.io/free-trial-conversion-rate) — Kirro
- [Trial conversion rates for in-app subscriptions](https://adapty.io/blog/trial-conversion-rates-for-in-app-subscriptions/) — Adapty
- [Fitness App Churn Rate in 2026](https://lifecyclearchitect.com/benchmarks/fitness-apps-churn-rate-benchmarks/) — Lifecycle Architect
- [Health & Fitness App Benchmarks 2026](https://www.businessofapps.com/data/health-fitness-app-benchmarks/) — Business of Apps

**Not legal advice.** §5 is a practitioner's summary of publicly documented FTC requirements.
Have the creator agreement reviewed before it is countersigned.
