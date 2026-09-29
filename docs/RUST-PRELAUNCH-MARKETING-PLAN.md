# Rust — Pre-Launch Social Marketing Plan

**Written 2026-09-14.** Rust is Heath's consumer fitness app (`Rust Fitness App, LLC`, repo
`/mnt/c/Users/Heath/Projects/Rust`, Supabase `aflqnvlhpkbokfneyhqh`, Vercel project `rust`).
Everything below was verified against the actual codebase on that date, not against prior
handoffs or memory files. Where a memory file disagrees with the code, the code wins and the
discrepancy is called out.

**Status: NOT LIVE.** iOS has been "Waiting for Review" since 2026-08-31 (~14 days). Android is
blocked on Google's Health-declaration scanner still reading version code 2's manifest. There may
additionally be an Apple account address/entity problem in flight. **Every CTA in this document is
waitlist or coming-soon. There is no "download now" anywhere, and the render pipeline now refuses
to build one.**

---

## 0. Read this part first: there is nowhere to send anyone

This is the finding that outranks every creative idea below.

| Asset | Status |
|---|---|
| Waitlist page | **Did not exist.** Zero matches for `waitlist`/`coming soon`/`early access` across `src/`, `public/`, `api/`, `index.html`. Prototyped today — see §6. |
| Custom domain | **None.** The only public URLs are `rust-eight-rosy.vercel.app` and `rust-heathshepard-6590s-projects.vercel.app`. |
| Social accounts | **None found.** No Rust handle appears anywhere in `docs/PIPELINE.md`, the Zernio account list, or any marketing doc in this repo. |
| Public support contact | `heath.shepard@kw.com` — **his Keller Williams real-estate address**, hardcoded in `Rust/public/support.html`. |
| Analytics | `src/lib/acquisition.ts` captures first-touch UTM + referrer into `localStorage`, but **only fires inside the app**, which nobody can install. Campaign traffic is currently unmeasurable. |

**What this means in plain terms:** if Heath posted the best fitness video of his life tomorrow,
the viewer's only options are a Vercel preview URL that looks like a phishing link, or nothing.
Every impression spent before the waitlist ships is wasted inventory.

**Fix order, before a single post goes out:**

1. **Buy a domain.** `rustfitness.app` or similar. ~$15-20/yr. This is a 10-minute Heath task and
   it blocks everything else — you cannot put `rust-eight-rosy.vercel.app` in a TikTok bio.
2. **Ship the waitlist page** (prototyped, §6) at that domain.
3. **Move the support email off `@kw.com`.** A fitness app whose public contact is a licensed
   REALTOR's brokerage address is both brand-confusing and a KW compliance smell — Heath's
   brokerage address appearing on a non-real-estate commercial product invites exactly the kind
   of question he doesn't want. Use `support@` at the new domain (ImprovMX forwards free).
4. **Create the social accounts** and put the domain in every bio.

Only then does the content calendar matter.

---

## 1. What Rust actually is (verified against code, 2026-09-14)

Do not market anything outside this list. The Dossie rule applies identically: **never demo a
capability that doesn't exist.**

**The coach cast — 6 coaches, 6 genuinely distinct ElevenLabs voices.**
Source: `Rust/api/tts.ts` `VOICE_MAP` (voice IDs + generation settings), `Rust/api/chat.ts`
`VOICE_PERSONAS` (personality system prompts), `Rust/src/components/VoiceSelector.tsx` (names,
titles, colors, sample lines).

| Coach | Title | ElevenLabs voice | Color | Character |
|---|---|---|---|---|
| **Marcus** | The Powerlifter | `nPczCjzI2devNBz1zQrb` (Brian) | `#6B7B8D` | Former competitive powerlifter, totaled 1800+. Calm, authoritative, doesn't waste words. "That's a number." |
| **Kira** | The Athlete | `21m00Tcm4TlvDq8ikWAM` (Rachel) | `#C77DBA` | Former D1 athlete, CSCS. Competitive, treats every user as an athlete because they showed up. |
| **Dev** | The Scientist | `JBFqnCBsd6RMkjVDRZzb` (George) | `#5B9BD5` | Exercise physiology background. Coaches through data, always explains the why. |
| **Val** | The Commander | `XB0fDUnXU5powFXDhCwa` (Charlotte) | `#D4694A` | Former military fitness instructor. Tough love, notices when you skip, accepts bad days but not excuses. |
| **Sage** | The Guide | `pFZP5JQG7iQjIQuC4Bku` (Lily) | `#7FAE86` | Yoga practitioner turned strength coach. Mind-muscle connection, longevity over numbers. |
| **Rico** | The Hype Man | `bIHbv24MWmeRgasZH58o` (Will) | `#E8A838` | Group fitness / transformation coach. Genuine, infectious energy. |

> **Correction to `rust-fitness-vercel-project.md`.** That memory file says the 6 personas share
> "only 2 underlying voice IDs (1 male, 1 female) differentiated by stability/style params." **That
> is stale.** As of the 2026-08-12 commit comments in `api/tts.ts`, all six have their own distinct
> ElevenLabs voice. This materially upgrades the marketing story: it's a real cast, not a filter.

**Real features, stated the way they're actually implemented:**

- **Readiness check before every session.** `src/components/ReadinessCheck.tsx` — three **1-to-5**
  sliders (sleep, energy, soreness) plus a 12-area sore-region picker that appears when soreness
  ≥ 3. `api/chat.ts:1784-1786` injects it into the coach's context as `Sleep n/5 | Energy n/5 |
  Soreness n/5`. **The coach advises on load. The workout generator does not silently rewrite
  your numbers from readiness.** Say it that way.
- **Progression logic.** `src/pages/Workout.tsx:341-351` and `886-901`. Three branches, per
  exercise, per session: avg reps ≥ target → **+5 lb**; avg reps < target → **hold the weight**;
  avg reps < 70% of target → **drop 10%**, rounded to nearest 5 lb, floored at 5 lb. Assisted
  exercises move the opposite direction (less assistance = harder).
- **Equipment catalog.** `src/constants/equipmentCatalog.ts` — **121 items across 10 categories**
  (re-counted today; confirms the hook library). One-tap presets in `equipmentPresets.ts`.
- **Persistent coach memory.** Supabase `coach_memory` — injuries, preferences, goals carried
  between conversations, with expiration dates. `coach_messages` keeps the last 20.
- **Health integration.** `src/lib/health.ts` via `@capgo/capacitor-health` — reads exactly four
  permissions: steps, heart rate, active calories (read + write). Not blood pressure, not sleep
  staging, not the 43 other permissions Google's stale scanner still lists.
- **Voice input** is browser-native Web Speech API, transcribed client-side. **No raw audio ever
  reaches the server.** This is a genuine privacy talking point most AI apps can't make.
- **Community feed, weekly challenges** (13 types — Volume King, Iron Streak, Heavy Hitter...),
  **nutrition tracking, yoga generator, history/analytics, custom exercises.**
- **Mid-set exercise demos** — `ExerciseDemoSheet.tsx` + `formCues.ts` + `exerciseVideos.ts`.
- Coach is **subscription-gated** (403 without an active/trialing sub). Price is **$19.99**
  (commit `f1b2c27`). iOS has **no StoreKit IAP built** — iOS earns $0 until it does.

### Claims in `marketing/rust-hook-library.md` that the code does NOT support

The hook library is otherwise strong and should keep being the source for opening lines — but
three entries are overclaims and must be cut or rewritten before use:

- **Hook #20 — "Deload week hits automatically every 5th week."** ❌ **Fabricated.** There is no
  calendar deload anywhere in the codebase. No week counter exists (`grep` for
  `week_number|weekIndex|programWeek|cycleWeek` returns nothing). The only "deload" in app code is
  the per-exercise 10% back-off after missed reps. `api/chat.ts` mentions "every 4-6 weeks" only
  as *coaching knowledge the AI can discuss*, not behavior the app executes.
- **Hook #35 — "I stopped guessing my own deload weeks. The app just does it."** ❌ Same problem.
- **Hooks #11 / #15 — "sleep was a 3 out of 10" / "watch it drop the weight before you even ask."**
  ⚠️ Two errors. The slider is **1-5, not 1-10**, and the coach *recommends* a lighter load in
  conversation — it doesn't auto-rewrite the session. Rewrite as: *"I told it I slept a 2 out of 5.
  Watch what Marcus does with that."*

The replacement is better anyway, because the real progression rule is a sharper hook than the
fake one: **"Hit your reps, it adds five pounds. Miss them badly, it takes ten percent off. That's
the entire algorithm, and it's more than your app does."**

---

## 2. The coach concept is the lead

Six characters with six real voices is the single most shareable asset Rust has, and no competitor
can copy it cheaply. Nobody shares "adaptive progressive overload." People share **characters** —
they pick a favorite, argue about it, and tag a friend with "you're such a Val."

This also solves the hardest pre-launch problem: **you can make compelling content about a product
nobody can install yet**, because the coaches are interesting on their own.

### 2a. Coach introduction videos — BUILT ✅

Nine videos rendered today to `Media/rust-conversations/`. Each coach introduces themselves **in
their own real in-app voice** — the same ElevenLabs voice a user hears after picking them, so the
promo isn't a different actor than the product.

| File | Length |
|---|---|
| `rust-coach-intro-marcus-vertical.mp4` | 24.2s |
| `rust-coach-intro-kira-vertical.mp4` | 22.8s |
| `rust-coach-intro-dev-vertical.mp4` | 22.8s |
| `rust-coach-intro-val-vertical.mp4` | 21.3s |
| `rust-coach-intro-sage-vertical.mp4` | 21.1s |
| `rust-coach-intro-rico-vertical.mp4` | 19.5s |

Scripts live in `scripts/conversation-scripts/rust/coach-intro-*.json`, written from each coach's
actual system prompt so the character on screen matches the character in the app.

### 2b. Heath ↔ coach conversation videos — BUILT ✅

Same format that just worked for Dossie and Luna: Heath's cloned voice (`i41TA0Q36AUrp4axERi3`,
locked config) in real dialogue with a coach's voice.

| File | Topic | Length |
|---|---|---|
| `rust-conv-readiness-marcus-vertical.mp4` | The readiness check — telling your coach you slept badly | 36.9s |
| `rust-conv-progression-dev-vertical.mp4` | How the app decides your next weight | 35.9s |
| `rust-conv-founder-val-vertical.mp4` | Why Heath built Rust | 42.6s |

### 2c. What was changed in the pipeline (reused, not rebuilt)

Per instruction, `scripts/generate-conversation-video.js` was **extended, not replaced**. Dossie's
existing path was regression-tested and still renders identically.

- **`scripts/voice-select.js`** — added a third brand owner, `rust`, with its own narrow
  `RUST_FOUNDER_CONTENT_TYPES` allowlist (`coach_conversation_heath`, `founder_story`,
  `build_in_public`, `feature_demo`) and a `RUST_COACH_VOICES` registry mirroring Rust's own
  `api/tts.ts`. Heath's clone is approved for Rust founder content; Bill and Luna are **not** and
  can never speak for Rust.
- **`scripts/generate-conversation-video.js`** — script JSON now takes `"brand": "rust"`, which
  switches speaker resolution (any of the 6 coach ids become valid speakers), swaps the card
  palette to Rust's real dark theme from `src/lib/theme.ts`, and tints each coach's name card in
  that coach's own app color.

**Three guardrails, all tested and firing:**

1. A `brand: "rust"` script with a CTA matching `/download|app store|play store|get it now|available now|install now/i` is **refused at render time.** Verified: `REFUSING brand="rust" CTA "Download now on the App Store" — Rust is not live in either store.`
2. `speaker: "dossie"` in a Rust script is **refused.** Verified: `Luna is a Dossie character voice; Rust has its own six coaches.`
3. Any non-ElevenLabs TTS fallback is **refused** rather than shipping a generic voice mislabeled as a real person or a real coach (pre-existing guard, message updated).

**Known limitation, stated plainly:** these renders are captioned color cards — a
podcast-clip aesthetic. That is genuinely fine for the *conversation* format and it is what
shipped for Dossie. It is **not** enough for TikTok on its own. The coach intros in particular
need real screen recordings of the app behind them before they'll hold a feed. See §4.

---

## 3. Why Rust is a different game than Dossie

Worth stating because it changes the whole strategy. Dossie sells to ~150k Texas REALTORS through
trust and proof. Rust sells to anyone who lifts. Consumer fitness **can** go viral; B2B software
essentially cannot. The implications:

- **Volume and iteration beat polish.** One video in thirty carries the account. That math only
  works if there are thirty.
- **Platform choice inverts.** LinkedIn is near-worthless here. TikTok and Reels are everything.
- **The founder is the product's main character.** Solo builder + real training + real coaches is a
  story. "Adaptive progressive overload" is not.
- **The audience is not warm.** Dossie has Heath's real-estate network. Rust has five friends.

---

## 4. Content formats, ranked by expected return

**Tier 1 — build these first**

1. **Coach intros** (built). Post as a cast rollout: one coach per day for six days, then a
   "which one are you?" poll post. Highest natural share/comment rate of anything here.
   *Needs upgrade: app screen recordings behind the audio.*
2. **"One sentence, rebuilt workout"** — screen-record typing a real sentence into the coach and
   show what actually comes back. Hook library #12, and it's demonstrably true.
3. **Readiness-check demo** — the 1-5 sliders, then Marcus's actual response. The single most
   differentiated thing the app does.
4. **Heath ↔ coach conversations** (3 built). Evergreen, cheap, infinitely extensible — one per
   feature, one per coach.

**Tier 2 — high value, more effort**

5. **Build-in-public.** The Google health-declaration saga is genuinely good content: *"Google
   thinks my app reads your blood glucose. It reads four things. I have the manifest to prove
   it."* Developer audiences love a well-documented platform-bureaucracy fight, and it's 100%
   true. Also: the 14-day review wait, the iPad screenshot rejection, the LLC, the UPS box.
6. **Founder story** (1 built). See §5 for the veteran framing rules.
7. **"Reply to a comment" videos.** Free format, zero scripting, strongest algorithmic signal on
   both TikTok and Reels. Requires comments, so it comes after the first traction.
8. **Coach-vs-coach.** Same question, two coaches, two genuinely different answers — generated
   live from the real system prompts. Cheap to make, very shareable, and it *proves* the cast is
   real rather than cosmetic.

**Tier 3 — later, or only if something pops**

9. Challenge formats (the 13 real challenge types are a natural hook, but need users first).
10. Transformation/progress content. **Heath has no before/after to show and should not fake one.**
    Hook #34 is the honest version: *"I'm not going to show you a before/after. I'm going to show
    you the coach adjusting my actual workout."*

---

## 5. The veteran story — handling rules

Heath is a 100% disabled veteran. On a fitness app this is real and relevant, and it is also the
single easiest thing in this plan to get wrong.

**The honest frame:** the readiness check exists because Heath's own capacity genuinely varies day
to day, and every app he paid for ignored that. That's a true, specific product origin — it
explains a real feature. It's the strongest version of the founder story precisely *because* it
isn't about the disability, it's about the software decision the disability produced.

**Hard rules:**

- **Never a credential.** Not "as a disabled veteran, I know fitness." He's not claiming expertise
  from it.
- **Never an outcome claim.** Rust does not treat, rehabilitate, manage, or accommodate any medical
  condition. Rust's own `api/chat.ts` contains an absolute medical-boundaries block — the coach is
  forbidden from diagnosing, recommending medication, or giving medical nutrition therapy. **The
  marketing must not promise what the product explicitly refuses to do.** This is the same
  never-demo-what-doesn't-exist rule, with FTC health-claim exposure attached.
- **Never a sympathy ask.** No "support a veteran-built app." It cheapens it and it converts worse.
- **Pairing with Val** (former military fitness instructor) is the tasteful way to let the service
  connection sit in the frame without anyone saying it out loud. That's how
  `conv-founder-val.json` is written.
- **Heath approves this script personally before it renders or posts.** Flagged in the script file
  itself.

---

## 6. The waitlist funnel — PROTOTYPED ✅

Built today in the Rust repo. **Not committed, not deployed** — needs Heath's review, a domain, and
a migration run.

| File | What it is |
|---|---|
| `Rust/public/waitlist.html` | Self-contained landing page. Rust's real dark palette, the six-coach cast as the hero, honest "not in the stores yet" status banner, waitlist form. |
| `Rust/api/waitlist.ts` | Unauthenticated POST handler. Service-role insert, upsert on email, optional Telegram ping to Heath. Typechecks clean under the repo's own strict config. |
| `Rust/migrations/029_waitlist.sql` | `waitlist` table — email, platform, `wants_to_test`, `coach_pick`, UTM columns, `invited_at`. RLS on with no public policy (a browser-writable public email list is a scrape target). |

**Verified in a real browser (Chromium via Playwright), not by reading the code:**

- 6 coach cards render; coach `<select>` populated with all 6 + "no preference".
- Platform picker auto-defaults from user agent (one less tap, and it makes the Android/iOS split
  in the data meaningful).
- Invalid email is blocked client-side and **no request is sent**.
- Valid submit posts the correct payload — UTM params captured straight off the URL:
  `{"email":"Tester@Example.com","platform":"android","coach_pick":"rico","wants_to_test":true,"utm_source":"tiktok","utm_campaign":"coach_intro_rico",...}`
- Tester-specific success message renders; button hides.
- A 502 from the API shows the friendly error and **re-enables** the button.
- No console or page errors other than the intentionally mocked failure.

*(Screenshots could not be captured — this Chromium build hangs after "fonts loaded". Functional
assertions above are real and passed. Worth a human eyeball on the visual before it ships.)*

**Why `coach_pick` is on the form:** it's a near-zero-friction engagement hook, and it's also the
cheapest real read available on which persona actually sells. That answers which coach to lead the
paid/organic push with, using data instead of taste.

**Why `wants_to_test` matters most:** Android testers are the current hard bottleneck. Google
requires **12 opted-in testers held 14 consecutive days**, and as of the last check there were 4
invited and **0 opted in**. The clock has not started. Every Android waitlist signup who ticks that
box is directly load-bearing on the launch date — this is the one field Heath should act on daily.

**Funnel shape:**

```
TikTok/Reels video  →  link in bio  →  rustfitness.app  →  waitlist form
                                                              ├─ Android + wants_to_test → Play closed-test invite (unblocks launch)
                                                              ├─ Android            → invite at open testing
                                                              └─ iOS                → email on release day
```

**Still needed before this is live** (all small, none done):
- A domain, pointed at the Rust Vercel project.
- Run migration `029_waitlist.sql` against Supabase `aflqnvlhpkbokfneyhqh`.
- Optional: set `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` on the **Rust** Vercel project (it inherits
  nothing from MeetDossie). Without them the endpoint logs and no-ops — signups still save.
- Optional: a `/waitlist` → `/waitlist.html` rewrite in `Rust/vercel.json`. The existing SPA
  catch-all excludes paths containing a dot, so `/waitlist.html` already works untouched.
- **No rate limiting or captcha.** Accepted at current traffic (~0). Revisit the moment a post
  actually lands — an open POST endpoint attracts junk fast.

---

## 7. Platforms

| Platform | Priority | Why |
|---|---|---|
| **TikTok** | **1** | Only platform that reliably delivers a zero-follower account to a real audience. Coach personalities are native to it. |
| **Instagram Reels** | **1** | Same content, second surface. Better for the cast/character angle and carousel explainers. Heath likely has an existing personal IG. |
| **YouTube Shorts** | 2 | Free third surface for the identical export. Near-zero marginal cost — just upload. |
| **Reddit** | 2 | r/homegym, r/fitness30plus, r/androidapps, r/selfhosted-adjacent dev subs. **High risk, high reward** — self-promo gets you banned fast. Participate for weeks before posting anything. Best channel for Android tester recruitment. |
| **X/Twitter** | 3 | Build-in-public/indie-dev audience only. Good for the Google-bureaucracy thread. Won't move consumer installs. |
| **Facebook** | 3 | Heath's warm network — worth one honest personal post for tester recruitment. Not a growth channel. |
| **LinkedIn** | **Skip** | Wrong audience entirely. It's Dossie's channel, not Rust's. |

**Do not reuse Dossie's Zernio account or personas.** Brenda/Patricia/Victor are fictional REALTOR
personas for a B2B product. Rust needs its own accounts and its own voice — Heath's. Zernio has 4
account slots at $18/mo already paid; check whether spare slots exist before paying for anything
new.

---

## 8. Realistic weekly output

Assuming the waitlist ships first and Heath has a few hours a week.

**Weeks 1-2 (setup + cast rollout)**
- 6 coach intro videos (**already built** — needs screen recordings layered in)
- 1-2 conversation videos (**3 already built**)
- Total: **5-7 posts/week across TikTok + Reels** (same asset, both platforms)

**Weeks 3-8 (steady state)**
- 3-4 new videos/week, each posted to TikTok + Reels + Shorts = **9-12 posts/week**
- 1 build-in-public text post (X + Reddit)
- Daily: reply to every comment. Non-negotiable — it's the cheapest ranking signal there is.

**Per-asset cost once the pipeline is warm:**
- Conversation/intro video: **~10 min** of Heath's time (approve script), ~3 min render, ~$0.30 ElevenLabs.
- Screen-recording-based demo: **~20-30 min** — Heath has to actually drive the app on camera.
- Build-in-public post: **~10 min**.

**Honest ceiling:** 3-4 genuinely good videos a week is sustainable for one person with a real
estate business and another SaaS. **Ten mediocre ones a week is worse than three good ones** — but
only on platforms where quality is scored. On TikTok, volume genuinely is a strategy, because
distribution is per-video, not per-account. Err toward volume here in a way you never would for
Dossie.

---

## 9. What needs Heath vs. what runs unattended

**Needs Heath (cannot be automated):**
- Buying the domain. **Blocks everything.**
- Approving the founder-story script before it renders (flagged in the file).
- Any on-camera or screen-recording footage — his hands, his app, his voice live.
- Creating the social accounts (phone verification).
- Posting, at least at first. New accounts posting via API look like bots and get suppressed.
- Replying to comments in his own voice.
- Reddit participation. Automated Reddit self-promo is the fastest possible ban.
- Recruiting the 12 Android testers — these are real people who need a real ask.
- The final call on anything touching the veteran framing.

**Runs unattended (already automated or trivially automatable):**
- Script → rendered video, both formats, any coach (`generate-conversation-video.js`).
- Voiceover synthesis, brand/CTA guardrails, refusal on a download CTA.
- Waitlist capture, upsert, UTM attribution, Telegram ping.
- Caption/hook generation from `marketing/rust-hook-library.md` (minus the three bad hooks in §1).
- Scheduling/queueing once accounts exist (Zernio, if a slot is free).
- Weekly report: waitlist signups by platform, by UTM, by coach pick.

**Explicitly NOT automated, on purpose:** posting Rust content without Heath seeing it. Rust has
no content-approval pipeline like Dossie's `social_posts` flow, and building one before there's an
audience is premature. Heath eyeballs everything until volume makes that impossible.

---

## 10. The honest part: what the first 1,000 actually costs

**Rust has ~5 users. All friends Heath texted it to** (Jeffrey McPherson, "Josh", "Bdub", "Bruke",
plus Heath). That is not traction and it is not an audience — it's a favor. There is no email list,
no followers, no newsletter, no community, and no warm channel that isn't Heath's personal
relationships.

Realistically, from zero:

- **A cold TikTok account's first 10-20 videos mostly get 200-500 views.** That's not failure,
  that's the entry fee. Plan on posting ~20 videos before anything resembling a signal.
- **The first 100 waitlist signups are the hardest.** Expect 6-10 weeks of consistent posting, or
  one video that unexpectedly does 50k+. You cannot schedule the second one, so you plan for the
  first.
- **1,000 waitlist signups is a 3-6 month project** at 3-4 videos/week, *assuming* at least one
  video breaks out. Without a breakout it's closer to 9-12 months, or it doesn't happen at all.
- **Time cost: 6-10 hours/week, every week, for months**, most of it Heath's — scripting, filming,
  replying. The rendering is the cheap part and it's already built.
- **Money cost is genuinely near zero**: ~$20/yr domain, ElevenLabs already paid for Dossie, Vercel
  and Supabase free tier. **The real currency is Heath's attention**, and it is already split
  across a brokerage practice, Dossie, and Sawyer.

**The one shortcut worth taking seriously:** the Planet Fitness manager who gave Heath an email
address for in-gym marketing materials — noted in memory, **still not acted on**. That is a warm,
in-person, physical-distribution channel sitting idle. It's worth more than the first month of cold
TikTok, and it costs one email. **Do that this week.**

**The honest alternative worth naming:** if 6-10 hours/week for six months isn't available, the
better play is to not run a content strategy at all — ship the waitlist, recruit the 12 Android
testers through Heath's existing network, launch, and let a small real user base generate the
content (challenges, feed activity, actual transformations) that makes marketing cheap later.
Pre-launch consumer content marketing with no audience and no time is the most reliable way to
spend months producing nothing.

---

## 11. Immediate next actions

| # | Action | Owner | Blocks |
|---|---|---|---|
| 1 | Buy a domain, point it at the `rust` Vercel project | **Heath** | Everything |
| 2 | Review `Rust/public/waitlist.html` + run migration `029_waitlist.sql` | Heath / Carter | Funnel |
| 3 | Move support email off `@kw.com` | **Heath** | Brand + KW exposure |
| 4 | Watch the 9 rendered videos in `Media/rust-conversations/` | **Heath** | Format go/no-go |
| 5 | Email the Planet Fitness manager | **Heath** | Nothing — just do it |
| 6 | Fix hooks #11/#15/#20/#35 in `marketing/rust-hook-library.md` | Sage | Caption accuracy |
| 7 | Create TikTok + IG accounts once the domain exists | **Heath** | Distribution |
| 8 | Layer app screen recordings behind the coach intros | Heath (capture) + Sage (edit) | Tier-1 quality |

---

## Appendix — files created or changed today

**MeetDossie (this repo):**
- `docs/RUST-PRELAUNCH-MARKETING-PLAN.md` — this document
- `scripts/voice-select.js` — **modified**: added `rust` owner, `RUST_FOUNDER_CONTENT_TYPES`, `RUST_COACH_VOICES`, `getRustCoachVoice()`. Dossie/heath-realtor paths regression-tested unchanged.
- `scripts/generate-conversation-video.js` — **modified**: `brand` support, Rust palette, coach speakers, CTA + cross-brand guardrails. Dossie's existing script re-rendered identically.
- `scripts/conversation-scripts/rust/*.json` — 9 new scripts (6 coach intros, 3 conversations)
- `Media/rust-conversations/*.mp4` — 9 rendered prototypes. **Not posted, not in `video_library`.**

**Rust repo (new files, uncommitted, not deployed):**
- `public/waitlist.html`, `api/waitlist.ts`, `migrations/029_waitlist.sql`
