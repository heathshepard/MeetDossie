# Content Format Library

**Written:** 2026-09-16. **Scope:** all repeatable content formats across Heath's three brands —
his realtor page, Dossie, and Rust. **Purpose:** the bottleneck is supply, not distribution. Posting
works; content runs out. This file defines formats precisely enough that a generator can be built
per format, and states honestly which ones need Heath in the room.

**Read alongside:** `docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md` (the binary quality gate every format
below must pass — §5 checklist, §5a machine-checkable engine spec), `docs/VIDEO-RULES.md`,
`docs/PIPELINE.md`, `docs/DOSSIE-VERIFIED-CAPABILITIES.md`, `docs/CONTENT-DO-NOT-WRITE-LIST.md`.

---

## 0. The three hard constraints this library is built around

**0.1 — Video only. No static cards.** Heath, 2026-09-12: "We aint doing static cards because they
suck ass and dont convert shit but if they are shorts or videos then lets see them."
(`feedback_video-only-no-static-cards.md`). The evidence behind the call: the 702 Fawndale static
Instagram post got **54 views and 1 like**. Consequence carried into every format below: *a platform
that cannot take video with the asset we have gets no post generated at all.* Generate video or
generate nothing. Canva/HCTI cards survive only as print, flyers, and still frames inside a video.

**0.2 — Screen recordings are the raw material and they are nearly gone.**
`Media/screen-recordings/` currently contains one directory and a queue file. `Media/feature-demos/`
holds 13 Dossie demos, all recorded 2026-09-07. This is exactly the exhaustion problem this document
exists to solve. The fix is not "record more" — it's formats whose source material is *regenerated
by the business itself*: a new MLS listing, a new Reddit pain quote, a new coach conversation, a new
closed deal.

**0.3 — The destinations do not exist yet.** The brief assumes 3 brands × 6 platforms = 18
destinations. **Eight exist today.**

| Brand | Live destinations (Zernio) | Missing |
|---|---|---|
| Dossie (`owner='dossie'`) | Facebook, Instagram, X, LinkedIn, TikTok | — (complete) |
| Realtor (`owner='heath-realtor'`) | Facebook, Instagram, YouTube | TikTok, X, LinkedIn |
| Rust | **none** | all six — plus the domain and the waitlist |

Rust has no accounts, no domain, and ~5 users who are all friends Heath texted
(`docs/RUST-PRELAUNCH-MARKETING-PLAN.md` §0, §10). Every Rust format below is *buildable today and
undistributable today*. That is a Heath task, not an engineering one, and it is the single largest
blocker in this document.

---

## 1. What we can actually produce today

Honest inventory of the production chain, because every recipe below is assembled from these and
nothing else.

| Tool | State | Real cost | Notes |
|---|---|---|---|
| **Playwright screenshot-loop capture** | Proven | $0 | `page.screenshot()` at ~14 fps, viewport 390×844 `deviceScaleFactor: 3` → true 1170×2532 frames. **`recordVideo` does NOT work** — it ignores `deviceScaleFactor` and letterboxes; CDP `Page.startScreencast` only returns CSS-pixel frames. |
| **`scripts/build-rust-shortform-video.py`** | Proven, passes all 16 §5a checks | $0 | The compositor. JSON spec in → hook card + full-bleed footage segments + punch-in + libass captions + multi-voice audio + ducked music bed + CTA card out. Mechanically brand-agnostic; the *constants* are Rust-specific (see §5.1). |
| **`scripts/generate-listing-video.js`** | Proven, 3 listings rendered | $0 | Ken Burns over real MLS photos → 9:16 + 1:1, varied transitions, lower-third, spec/price pills, TREC closing card, VO-synced sections, ducked music. |
| **`scripts/listing-marketing-generate-live.js`** | Proven | $0 | Atomic live connectMLS read + generate, in one process. **The only safe way to generate listing content** — `api/cron-daily-listing-posts.js` was killed 2026-09-11 for advertising a stale $1,195,000 against a live $999,000. Never re-enable that cron. |
| **`scripts/feature-demo-recorder.js`** | Proven | $0 | Playwright against production `meetdossie.com/app` as `demo@meetdossie.com`, driven by scene-script JSON. Currently outputs webm via `recordVideo` — needs the screenshot-loop swap (§5.1). |
| **`scripts/record-tutorial-bite.js`** | Proven | ~$0.15 | Playwright flow + Luna VO + ffmpeg + Supabase upload + `tutorial_videos` row. |
| **ElevenLabs** | Proven, locked config | **~$0.0006/char** | Creator $18.33/mo, 30k credits, ≈1 credit/char on `eleven_v3`. A 550-char VO ≈ **$0.34**. Heath clone `i41TA0Q36AUrp4axERi3` (stability 0.3, style 0.4, speaker_boost on, speed 0.9-1.15×, never re-tune). Luna `lxYfHSkYm1EzQzGhdbfc` = Dossie. Rust coaches use their own in-app `VOICE_MAP` IDs. |
| **`scripts/voice-select.js`** | Proven | $0 | Enforces brand/voice separation in code. |
| **Pexels** | Proven | $0 | Stock b-roll. Blocklist: sad/stressed/worried/sleeping/down/hunched. Min width 1080. |
| **Creatomate** | Proven | $0 on current plan | Karaoke captions, audio ducking, deterministic 1080×1920, CDN hosting. Template `791117d0-...`. |
| **Submagic** | Proven, **manual upload only** | $12/mo flat | API needs the $60/mo Business tier. Used for Heath's selfie footage. |
| **fal.ai + Kling 2.5** | Wired, **restricted** | $0.84/5s | **Banned for any real property footage** — generative models warp architecture between frames; that is a misrepresentation risk on a TREC-regulated ad. Abstract b-roll only, and see §6 on AI-disclosure risk. |
| **ffmpeg (WSL)** | Proven | $0 | **No `drawtext` filter in this environment.** All text goes through libass (`subtitles=` + `fontsdir=`) or Playwright HTML→PNG. |
| **`Media/Music/`** | 2 tracks only | $0 | Pixabay Content License, commercial, no attribution. **This is a real bottleneck** — ElevenLabs music generation returns `missing_permissions: music_generation` on our key, and Pixabay's CDN 403s non-browser downloads and throttles after ~2 per session. Two tracks across three brands will sound repetitive fast. |

**Marginal cost of a video is essentially ElevenLabs credits.** Everything else is flat-rate or
free. The real cost is *time*, and the real scarcity is Heath's attention.

---

## 2. Brand A — Heath's realtor page (KW City View, San Antonio / Boerne)

**Live destinations:** Facebook (`HeathShepardRealtor`), Instagram (`@heathshepardrealtor`),
YouTube ("Shepard Real Estate Solutions"). TikTok / X / LinkedIn are **not connected** — a Heath
decision (§8).

**Standing guardrails on every format in this section:**
- `listing-copy-never-signal-weakness.md` — no hint of a future price cut, no "motivated seller,"
  no "priced to sell," no DOM emphasis, no apologizing for price. Heath represents the seller;
  copy that invites lowballs is a fiduciary problem, not a style problem.
- `heath-marketing-must-pass-practitioner-test.md` — any position on practice must carry its real
  exception. A flat absolute marks the writer as someone who doesn't practice.
- `heath-verified-war-stories.md` — **only two approved real stories exist.** Generators may not
  invent a client, a deal, a family detail, or a resource.
- `docs/CONTENT-DO-NOT-WRITE-LIST.md` — every script runs the machine-readable block-level index
  before render. Fair-housing steering language (`good schools`, `safe area`, `family
  neighborhood`, `up-and-coming`) is a **HARD_BLOCK**.
- **TREC advertising rules** (535.154/535.155, verified against
  [TREC's own social-media guidance](https://www.trec.texas.gov/forms/social-media-and-advertising)):
  social media and video *are* advertisements. The broker name must appear at **≥ half the size of
  the largest agent/team contact info**, "readily noticeable." Team names must be TREC-registered
  before use in any ad. On character-limited platforms a "TREC DISCLOSURE" hyperlink satisfies the
  requirement when full text would exceed 10% of the character limit. `TREC_ATTRIBUTION` in
  `scripts/_lib/listing-marketing-facts.js` carries the correct string; **the size ratio on the
  closing card has never been measured against the rule — that is an open verification item.**

### R1 — Ken Burns Listing Reel

| | |
|---|---|
| **Job** | Hook cold (a buyer scrolling) + convert (a showing request) |
| **Source** | Real MLS photos + live-verified facts from `listing-marketing-facts.js`, read fresh from connectMLS in the same process that generates the copy |
| **Human?** | **Fully automatable.** Photos come from the MLS listing Heath already uploaded. |
| **Recipe** | `listing-marketing-generate-live.js` (live MLS verify — aborts and alerts if the read fails or verifies zero listings, never falls back to a cached snapshot) → `gen-listing-voiceover.py` (Heath's clone, locked settings) → `generate-listing-video.js` (Ken Burns 9:16 + 1:1, varied transitions, fast cuts in the first 5s, TREC closing card) → Telegram approval → Zernio |
| **Build state** | **T0 — ships today**, with one gap: the live generator currently emits *text* posts only. Extension = trigger the video build from the same atomic run. |
| **Cuts** | 28-34s master (YouTube Short, and TikTok when connected) · 12-15s IG loop cut (single best room + hook + address) · 1:1 square for the FB feed |
| **Hook** | Playbook §2 realtor bank. Lead on the single best real photo already in Ken Burns motion — never a title card. Angle rotation from `ANGLES`: `room_feature`, `price_value`, `neighborhood_lifestyle`, `buyer_fit`, `agent_to_agent`, `showing_availability` |
| **CTA** | "Text me for a private showing" + his direct line. Never a link in the post body. TREC attribution card, 2-2.5s hold |
| **Cost** | ~$0.35 VO. $0 render |
| **Time** | ~15 min unattended once photos are in the folder |
| **Freshness** | 6 angles × active listings. At 3 active listings that is **18 distinct videos** — ~18 weeks at 1/wk before an angle repeats on the same property. Refreshed by: a new listing, a new photo set, a status change. A price change is a refresh input but the copy must never reference the change itself. |

### R2 — TREC Process Explainer (screen-recorded form)

| | |
|---|---|
| **Job** | Teach — and it is the strongest differentiator Heath has, because almost nobody puts the actual form on screen |
| **Source** | Blank TREC forms (public), the coordinate maps in `api/_assets/field-maps/`, and the allowlist logic in `CONTENT-DO-NOT-WRITE-LIST.md` |
| **Human?** | **Fully automatable** once the topic passes the block-level gate |
| **Recipe** | Playwright renders the TREC PDF page → screenshot-loop capture → punch-in on the specific paragraph → Heath clone VO → shortform compositor (captions, music bed, CTA card) |
| **Build state** | **T1 — extension.** Needs the compositor parameterized (§5.1) and a frame source that is a PDF render rather than a live app |
| **Cuts** | 25-34s master (YouTube Short) · 10-14s IG loop (one clause, one punch-in) · 1:1 for FB |
| **Hook** | Playbook §2 #19: "I've closed enough of these to know the clause everyone skips. Watch." |
| **CTA** | "Questions on your own contract — text me." TREC attribution card |
| **Cost** | ~$0.40 VO |
| **Time** | ~25 min |
| **Freshness** | ~20 clean topics survive the do-not-write gate (option period ¶23 as a *paid unrestricted termination right*, earnest money to the **title company** not the broker, title commitment ¶6A, survey ¶6C, third-party financing addendum, SDN §5.008, statutory intermediary — *not* "dual agency is illegal," as-is under *Prudential v. Jefferson*, non-judicial foreclosure under §51.002, community property vesting, no TX transfer tax, TDI-promulgated title premiums). **~20 videos ≈ 20 weeks at 1/wk.** Refreshed by: a TREC form revision, a real question from a live deal, a new entry on the do-not-write list |

### R3 — "Ask a REALTOR" FAQ, Heath on camera

| | |
|---|---|
| **Job** | Hook cold + build trust. The one format where his face is the point |
| **Source** | Real questions — his 192k searchable SMS archive, kw.com Gmail threads, and the `engagement_queue` rows scraped from real FB REALTOR groups |
| **Human?** | **Needs Heath.** This is the format that cannot be faked, and the research is explicit that it shouldn't be |
| **Recipe** | Heath records 45-90s per question on his phone → Submagic (manual upload, captions) → ffmpeg appends the TREC attribution card → Telegram approval → Zernio. Alternative when he shoots against green: `generate-talking-head-video.js` composites him over a screen recording |
| **Build state** | **T0** for the Submagic path. **T1** to auto-append the TREC card and auto-queue |
| **Cuts** | 30-45s master (YouTube Short) · 12-15s IG cut of the single sharpest sentence · 1:1 for FB |
| **Hook** | The question itself, as on-screen text at frame 0, in the asker's words |
| **CTA** | "Got one? Ask me." — reply-driven, not link-driven |
| **Cost** | $0 marginal (Submagic is flat $12/mo) |
| **Time** | **Heath: ~20 min per sitting for 4 questions.** Post-production ~10 min each |
| **Freshness** | **Effectively unlimited** as long as real questions keep arriving, which they do. Batch 4 per 2-week sitting = 2/wk supply against a 1/wk draw. This is the most sustainable format in the whole library, and the only one that depends entirely on Heath showing up |

### R4 — Hill Country / Boerne Local

| | |
|---|---|
| **Job** | Hook cold, local. The best-sourced non-listing format in the research |
| **Source** | Heath's own phone b-roll of places he actually goes, plus verified public data. **Not Pexels stock standing in for a real place** — that fails the swap test and edges toward misrepresentation |
| **Human?** | **Needs Heath, lightly.** 10 minutes of phone footage whenever he's out. No performance, no script, no camera-facing |
| **Recipe** | Heath's clips → `generate-lifestyle-video.py` (assembly, transitions) → Heath clone VO → Creatomate captions → TREC card |
| **Build state** | **T1** — needs a "local" recipe path plus a hard fair-housing gate on every generated line |
| **Cuts** | 21-30s master · 8-12s IG loop · 1:1 for FB |
| **Hook** | A specific, checkable fact about the place — never a superlative |
| **CTA** | Soft. "Moving to the area? I live here." |
| **Cost** | ~$0.35 VO |
| **Time** | ~20 min after footage exists |
| **Freshness** | ~12-15 places he genuinely frequents. Refreshed by each trip and by each new listing's actual neighborhood |
| **Evidence caveat** | The strongest number found — 46 leads / 6 months, 29 organic, 55% engagement, 76 top-10 keywords from 31 neighborhood posts — is **a single agent case study on a vendor's blog**, not a benchmark ([Luxury Presence, 2026](https://www.luxurypresence.com/blogs/real-estate-community-guide/)). Treat as directional |

### R5 — Offer-Desk Breakdown (anonymized numbers on screen)

| | |
|---|---|
| **Job** | Teach, and convert sellers. The practitioner-test winner: real math, no address, no names |
| **Source** | His own received-offer net-sheet process (`received-offer-net-sheet-process.md`), fully anonymized |
| **Human?** | **Fully automatable from an anonymized input**, but the anonymization decision is Heath's on the first few |
| **Recipe** | Render an anonymized net sheet as HTML → Playwright screenshot loop → punch-in per line item as the number lands → Heath clone VO → shortform compositor |
| **Build state** | **T2 — new build**, but it reuses the compositor entirely. Net new work is the anonymizer + the HTML renderer |
| **Cuts** | 28-34s master · 10-15s IG loop of the single surprising line item · 1:1 for FB |
| **Hook** | Playbook §2 #20 shape: "This is what a $10,000-over-asking offer actually nets." |
| **CTA** | "Want yours run? Text me." |
| **Cost** | ~$0.40 |
| **Time** | ~30 min first, ~15 min after |
| **Freshness** | One per closed or received-and-declined offer. **~1/month.** Low volume, highest credibility |
| **Hard guardrail** | Never a live file. Never anything identifying. **The Low Oak earnest-money file is off-limits entirely** — it is an active dispute (`low-oak-earnest-money-dispute.md`) |

### R6 — Just Sold / Under Contract, in motion

| | |
|---|---|
| **Job** | Social proof |
| **Source** | An MLS status change detected by `listing-marketing-status-sync.js` |
| **Human?** | Fully automatable, event-triggered |
| **Recipe** | `generate-listing-video.js` with a `--status sold` variant: 3-5 real photos, Ken Burns, motion stamp, music bed, TREC card |
| **Build state** | **T1** — a status variant on an existing generator |
| **Cuts** | 12-18s only. This is a short format by nature |
| **Hook** | One line about what was genuinely hard about the deal, in his voice |
| **CTA** | None hard. The proof is the post |
| **Cost** | ~$0.20 (short; often music + text only, no VO) |
| **Time** | ~10 min unattended |
| **Freshness** | Event-driven, ~1-2/month |
| **Hard guardrails** | **Never show the sale price** (`dossie-post-closing-testimonial-request.md`). **MLS status is the sole source of truth** — never infer under-contract or closed from a PDF or an envelope (`feedback_mls-status-is-sole-source-of-truth.md`). Cap at one post per close; the research calls plain sold-graphics saturated, and the only thing that rescues this format is the story attached to it |

### R7 — Market Reality Check (bounded, monthly)

| | |
|---|---|
| **Job** | Teach. Deliberately constrained, because the research does not support this as a short-form staple |
| **Source** | Real SABOR data pulled through connectMLS. No third-party stat, ever |
| **Human?** | Fully automatable once the SABOR pull is scripted |
| **Recipe** | connectMLS stats pull → chart render (per the `dataviz` skill) → Playwright screenshot loop of the chart animating → Heath clone VO → compositor. **YouTube-first, horizontal 2-4 min**, plus one 25s vertical pull-quote |
| **Build state** | **T2 — new build.** Needs the SABOR stats pull and a chart renderer |
| **Cuts** | 2-4 min horizontal (YouTube primary) · one 25s vertical cut of the single most surprising number |
| **Hook** | The number that contradicts what people assume |
| **CTA** | "Full breakdown on the channel" |
| **Cost** | ~$0.50 |
| **Time** | ~45 min/month |
| **Freshness** | Monthly by definition. 12/yr |
| **Why bounded** | Evidence on market-update videos is genuinely thin and split — one source claims a 52% engagement rate with no methodology ([Reel-E](https://www.reel-e.ai/blog/real-estate-marketing-statistics)), another says the format performs better as 2-4 min YouTube than as short-form ([Amplifiles](https://www.amplifiles.ai/blog/real-estate-social-media-statistics)). Nothing found says it's ignored; nothing found says it's strong. It also sits one step away from the weakness trap — any market-softness framing on a page where Heath lists properties concedes something to a buyer's agent. Keep it monthly, keep it long-form, keep it about the market and never about a specific listing's price history |

---

## 3. Brand B — Dossie (TC software for Texas REALTORS)

**Live destinations:** Facebook, Instagram, X, LinkedIn, TikTok — all five connected under
`owner='dossie'`.

**Standing guardrails:**
- `dossie-demo-must-match-real-capability.md` — **no marketing may show, describe, or imply a
  capability that doesn't work in the live product today.** Heath: "Let's just make sure that Dossie
  can actually do everything we're demonstrating." This is the most expensive error class available
  to us, because the prospect *acts* on it.
- **`docs/DOSSIE-VERIFIED-CAPABILITIES.md` is the allowlist.** Formats below draw only from items
  verified **WORKS** (1-14). Never from PARTIAL (e-sign, Send-to-Compliance, Gmail connect),
  UNVERIFIED (Compliance Vault), or DOESN'T EXIST (CMA, MLS, SMS, per-agent contract defaults,
  brokerage portal upload).
- **Voice scope, stated precisely** because the shorthand in `heath-voice-clone-usage-scope.md`
  reads as a flat ban and the playbook does not: Heath's clone may speak **as Heath** in Dossie
  founder and instructional content. It may **never speak as Dossie**. Dossie's character voice is
  Luna `lxYfHSkYm1EzQzGhdbfc`, always, and this is enforced in `scripts/voice-select.js`.
- **CTA is `meetdossie.com`.** Never `/founding` — founding closed 2026-08-04 and never reopens.
- Persona rule from `docs/PIPELINE.md`: MeetDossie-brand content is third-person Brenda/Patricia/
  Victor. Heath's own founder content is first-person and lives on **his** page, not this one.
  Do not cross-contaminate.

### D1 — Real-Question Screen Demo ("Ask Dossie")

| | |
|---|---|
| **Job** | Demonstrate. The flagship format |
| **Source** | Real TREC questions + the verified-capability allowlist. Every scripted Dossie answer maps to a WORKS item before render |
| **Human?** | **Fully automatable** |
| **Recipe** | `feature-demo-recorder.js` scene script → Playwright screenshot loop at 390×844 dsf3 against production as `demo@meetdossie.com` → Luna VO for Dossie's line, Heath's clone for the question → shortform compositor (hook card, punch-in on the answer as it renders, verbatim captions, music bed, CTA card) |
| **Build state** | **T1 — extension.** The recorder exists but still uses `recordVideo`, which letterboxes; swap it to the screenshot loop. The compositor needs §5.1 |
| **Cuts** | 21-34s TikTok · 7-15s IG loop of the single answer moment · YouTube Short (same master) · 1:1 for X and FB · native video for LinkedIn |
| **Hook** | Playbook §2 #16: "I asked Dossie what happens if the option period ends on a Saturday. Watch the answer." |
| **CTA** | `meetdossie.com` end card, 2-2.5s |
| **Cost** | ~$0.35 |
| **Time** | ~30 min |
| **Freshness** | ~14 WORKS capabilities × ~3 credible real questions each ≈ **40 distinct videos**. Refreshed by: a newly shipped feature (**re-verified in the live app first**), and by a new Reddit pain quote reframed as the question |

### D2 — Reddit Pain → Dossie Answer

| | |
|---|---|
| **Job** | Hook cold. The highest swap-test score of any Dossie format, because the opening words are real |
| **Source** | The `reddit_pain_language` table — real pain language scraped from r/realtors, r/RealEstateAgents, r/RealEstateAdvice by `scripts/reddit-pain-scraper.js` |
| **Human?** | Fully automatable. **Caveat:** the scraper must run from Heath's machine on a schedule — Reddit rate-limits and blocks bursty requests from datacenter IPs |
| **Recipe** | Pull an unused quote → map it to a WORKS capability (reject if no honest match exists) → open on the real quote as full-bleed text with motion → cut to the app doing that exact thing → Luna VO → compositor |
| **Build state** | **T1** — the table and scraper exist; the missing piece is the quote→capability mapper, which must be allowed to return "no match" and skip |
| **Cuts** | 21-30s TikTok/Shorts · 8-12s IG loop · 1:1 for X/FB · LinkedIn native |
| **Hook** | The quote, verbatim, unedited. That *is* the hook |
| **CTA** | `meetdossie.com` |
| **Cost** | ~$0.35 |
| **Time** | ~25 min |
| **Freshness** | **Effectively unlimited while the scraper runs.** This is the only Dossie format with a self-refilling source. Refresh cadence = the scraper's schedule |

### D3 — Founder Explainer, Heath on camera

| | |
|---|---|
| **Job** | Convert skeptics. This format exists specifically because of what the research says about this audience |
| **Source** | `docs/WEEKLY-RECORDING-KIT.md` Dossie scripts, and **only** the two approved stories in `heath-verified-war-stories.md` |
| **Human?** | **Needs Heath, on camera** |
| **Recipe** | Heath records 45-75s → Submagic captions → ffmpeg appends the `meetdossie.com` card → Telegram → Zernio |
| **Build state** | **T0** via Submagic; **T1** to auto-append the card |
| **Cuts** | 45-75s master (the testimonial-length band) · 12-15s IG cut · LinkedIn native · 1:1 for FB/X |
| **Hook** | The moment the thing went wrong, stated flatly |
| **CTA** | `meetdossie.com` |
| **Cost** | $0 marginal |
| **Time** | **Heath: ~15 min per batch of 3** |
| **Freshness** | **This is the choke point of the entire Dossie library.** Only two verified war stories exist: (1) the TC went dark mid-transaction; (2) the earnest-money deadline missed by three days, which cost $5,200 — and that one is an **active dispute**, so all parties unnamed, no address, no identifying dates, never characterize fault. At 1 video per story-angle that is maybe 6 videos total before it is transparently the same two stories. **Refresh requires Heath telling a new true story, and it must be written into the allowlist the same day he says it.** |
| **Why it earns its slot anyway** | Real survey data, not blog opinion: buyer trust in AI for home search fell to **16%, down from 30% a year prior**, 44% would pay more for human verification of AI output, and 64% worry AI recycles unverified information ([Cotality survey via Real Estate News / Inman, April-May 2026](https://www.realestatenews.com/2026/05/09/consumers-increasingly-wary-of-ais-role-in-homebuying)). Brokerage-side, only 2% plan zero AI adoption but "confidence is shaky," with accuracy and compliance the top concerns ([HousingWire, 2026](https://www.housingwire.com/articles/real-estate-brokerage-ai-adoption-hits-a-tipping-point-as-holdouts-disappear/)). Against an audience moving *away* from trusting AI, a real founder's face doing an unpolished take is the only asset we have that an AI-generated competitor cannot copy |

### D4 — Deadline Math Proof

| | |
|---|---|
| **Job** | Demonstrate. Pure product proof with zero claim beyond what renders on screen |
| **Source** | Verified capability #6 — the TREC deadline calculator, which cites real paragraph numbers (¶5A, ¶5B, ¶6A, ¶9A) and recomputes live when a date field is edited |
| **Human?** | Fully automatable |
| **Recipe** | Screenshot-loop capture of a date being edited → hold on the recomputed deadline long enough to read → punch-in on the citation → Luna VO → compositor |
| **Build state** | **T1** |
| **Cuts** | 15-25s TikTok/Shorts · 7-12s IG loop (the single number changing) · 1:1 for X/FB |
| **Hook** | Playbook §2 #15 shape: "Every TC software I tried made me re-type the same deadline three times. This one doesn't." |
| **CTA** | `meetdossie.com` |
| **Cost** | ~$0.30 |
| **Time** | ~20 min |
| **Freshness** | ~15 date scenarios — the Friday-execution trap, an option period landing on a Saturday, a holiday-shifted financing deadline, a title commitment chain. **~30 weeks at 0.5/wk.** Refreshed by a TREC form change or a new real deadline trap from a live deal |
| **Hard guardrail** | Playbook §5 item 4a: no claim may contradict a value visible on screen at that moment, and anything cited must be *shown first*, held ~1.5-2s. Do not speed-ramp past the frame where the number actually changes |

### D5 — LinkedIn Document Carousel — **DECISION REQUIRED, DO NOT BUILD YET**

| | |
|---|---|
| **Job** | Teach, and reach a B2B audience on the one platform where the data is real |
| **The evidence** | Van der Blom's Algorithm Insights report (~1.3M LinkedIn posts analyzed — **the only genuine large-sample study in this entire research set**): document/PDF carousels get **6.6-7.0% average engagement and a 2-3× reach multiplier**, the top format on the platform. Native video gets 5.6% but **video views are down 36% year over year**. Text-only runs ~0.9-2%. ([Dataslayer summary, Feb 2026](https://www.dataslayer.ai/blog/linkedin-algorithm-february-2026-whats-working-now)) |
| **The conflict** | A LinkedIn document carousel is a native multi-page PDF, not an HCTI social card — a different artifact on a different platform with real data behind it. But Heath's rule (`feedback_video-only-no-static-cards.md`) is unqualified: *"no cards."* **This format is written down and deliberately not built.** It is a decision only Heath makes, and the evidence is presented here so he can make it once |
| **If approved** | T2. Playwright renders a multi-page PDF; zero marginal cost; ~20 min each; ~15 topics of runway |

### D6 — Coordinator-to-Coordinator (Door B)

| | |
|---|---|
| **Job** | Convert the second audience — TCs scaling solo to 3× files, not agents replacing a TC |
| **Source** | Verified capability #10, the 10-stage pipeline board with real dossier cards and computed urgency text |
| **Human?** | Fully automatable |
| **Recipe** | Screenshot-loop capture of the pipeline board at volume → Luna VO → compositor |
| **Build state** | **T1** (same recorder, different scene script) |
| **Cuts** | 21-30s TikTok/Shorts · 1:1 for X/FB · LinkedIn native |
| **Hook** | Throughput, stated as a number that is actually on screen |
| **CTA** | `meetdossie.com` |
| **Cost** | ~$0.35 · **Time** ~25 min |
| **Freshness** | ~8 videos. Narrow audience, deliberately low volume. ~1 every 3 weeks |

### D7 — "Watch It Flag" — Contract Scan Audit

| | |
|---|---|
| **Job** | Demonstrate, at the highest proof level available. The single most impressive verified thing the product does |
| **Source** | Verified capabilities #3 and #4: upload a real TREC PDF, ~55s, ~50 fields pre-filled or flagged, and a real audit banner — *"Missing signatures (2), Missing initials (8), Blank required fields (13), Missing addenda (1)"* plus the specific correct catch *"Third Party Financing Addendum (indicated as checked in Paragraph 3B)"* |
| **Human?** | Fully automatable |
| **Recipe** | Screenshot-loop capture of a real upload → time-compress the wait (**never past a frame a claim depends on**) → punch-in on the audit banner as it renders → Luna VO → compositor |
| **Build state** | **T1** |
| **Cuts** | 25-34s TikTok/Shorts · 10-15s IG loop of the banner appearing · 1:1 for X/FB · LinkedIn native |
| **Hook** | Playbook §2 #18: "She caught the missing signature before I did." |
| **CTA** | `meetdossie.com` |
| **Cost** | ~$0.35 · **Time** ~30 min |
| **Freshness** | ~10 videos — different sample contracts with different real defects. Refreshed by each new sample contract |
| **Why it works on this audience** | The authenticity-over-polish finding repeated across 2026 sources: buyers tune out scripted content, and demos that show real friction read as more credible ([FreeRadical, 2026](https://freeradical.co/research/the-5-authentic-videos-every-b2b-brand-should-create-in-2026/)). A video whose entire payoff is the software *finding a problem* is the strongest possible version of that. **Do NOT claim the scan is complete or needs no review** — the product's own UI says "Needs review" and lists real gaps. That honesty is the asset |

---

## 4. Brand C — Rust (AI fitness coaching, pre-launch, waitlist only)

**Live destinations: none.** Read `docs/RUST-PRELAUNCH-MARKETING-PLAN.md` §0 before anything here
matters. Everything below is buildable today and undistributable today.

**Standing guardrails:**
- **Never "download now" / "get it on the App Store."** iOS is in review with manual release,
  Android is blocked in closed testing behind a Google-side health-scanner lag
  (`rust-app-store-submission-state.md`). The only honest CTA is `rustfitness.app · join the
  waitlist`. This refusal is already enforced at render time in
  `scripts/generate-conversation-video.js` and verified firing.
- **Readiness sliders are 1-5, not 1-10. Price is $19.99. There is NO calendar-based deload** — the
  only real mechanic is a per-exercise 10% back-off after missed reps. ⚠️ **`marketing/rust-hook-library.md`
  line 1 still says "deload every 5th week." That line is stale and contradicts the code-verified
  finding in the prelaunch plan and the playbook. Do not generate from it; fix it.**
- **Never invent user counts, testimonials, or results.** Rust has ~5 users, all friends.
- A coach's spoken lines use **that coach's own in-app ElevenLabs voice** (`Rust/api/tts.ts`
  `VOICE_MAP`, mirrored in `scripts/voice-select.js`). If the real voice can't be reproduced, ship
  silent and say so — never substitute a random voice for a named persona.

### U1 — Readiness → Coach Adjustment  ⭐ the proven one

| | |
|---|---|
| **Job** | Demonstrate. The single most differentiated thing the app does |
| **Source** | A real conversation, captured live against the deployed app |
| **Human?** | Fully automatable end to end, including the disposable test account (a fresh sign-up already gets a `trialing` subscription from the `create_trial_on_signup` trigger; delete it afterward via the app's own `POST /api/delete-account`) |
| **Recipe** | Playwright screenshot loop, 390×844 dsf3, ~14 fps → `build-rust-shortform-video.py` spec → ElevenLabs (Heath's clone for his lines, the coach's real in-app voice for theirs) → Pixabay bed 20 LU under → CTA card → loop-back frame |
| **Build state** | **T0 — PROVEN.** `Media/rust-videos-v2/2026-09-16/readiness-marcus-v3.mp4`, 33.77s, passes all 16 §5a checks: frame diffs at 0/2.5/4.6/9/20/26/32/33.7s, caption bounding boxes with **0.00%** app text underneath, `scribe_v1` STT of the final mix returning the script verbatim, first-vs-last frame diff of 0.01%. **This is the reference implementation for every screen-demo format in this document** |
| **Cuts** | 21-34s TikTok master · 7-15s IG loop of the weight changing · YouTube Short |
| **Hook** | Playbook §2 #5: "Told it I slept a 2 out of 5. Watch what happens to the weight." |
| **CTA** | `rustfitness.app · join the waitlist` |
| **Cost** | ~$0.40 |
| **Time** | ~2h first build, **~45 min repeat** (capture the take, write the spec, verify frames) |
| **Freshness** | 6 coaches × ~4 readiness scenarios = **24 videos**. Refreshed by a new coach, a genuinely new conversation, or a model change |
| **Known trap** | The readiness check only renders when there are **zero `coach_messages` rows for the local day**. A direct PostgREST `DELETE` returns 204 and deletes nothing (no RLS DELETE policy) — use `POST /api/chat {"mode":"clear_history"}` |

### U2 — One Sentence, Rebuilt Workout

| | |
|---|---|
| **Job** | Demonstrate. Hook library #12, and demonstrably true |
| **Source** | One real typed sentence ("my shoulder's bad today") and the real session rewrite that comes back |
| **Human?** | Fully automatable |
| **Recipe** | Same capture + compositor as U1, new spec |
| **Build state** | **T1** — a new spec against a proven pipeline |
| **Cuts** | 21-30s TikTok · 7-12s IG loop (the exercise swapping) · YouTube Short |
| **Hook** | Playbook §2 #8: "You said your shoulder hurts. Watch it swap the exercise before you finish typing." |
| **Cost** | ~$0.35 · **Time** ~45 min |
| **Freshness** | ~15 distinct sentences |

### U3 — Coach vs. Coach  ⭐ highest-yield Rust format

| | |
|---|---|
| **Job** | Hook cold, and share. Proves the cast is real rather than cosmetic |
| **Source** | The same question put to two coaches, answered live from their real system prompts, in their real voices |
| **Human?** | Fully automatable |
| **Recipe** | Two capture runs → split-screen or hard-cut composite → both coaches' real in-app voices → compositor |
| **Build state** | **T2** — needs a two-column composite mode in the compositor. Everything else exists |
| **Cuts** | **7-15s IG loop is the primary cut here** — the contrast lands instantly and Instagram loops aggressively (a 7s video watched 3× reads as 300% retention) · 21-30s TikTok for the longer exchange · YouTube Short |
| **Hook** | Playbook §2 #10: "Six coaches, six real voices. This one doesn't let you off easy." |
| **CTA** | `rustfitness.app · join the waitlist`, plus "which one are you?" as the comment prompt |
| **Cost** | ~$0.45 (two voices) · **Time** ~50 min |
| **Freshness** | **15 coach pairs × N questions. The highest-yield format in this entire document** — nothing else comes close on distinct-videos-per-unit-of-build-effort |

### U4 — Progression Math on Screen

| | |
|---|---|
| **Job** | Teach. The one real, code-verified mechanic |
| **Source** | A real set being logged; the working weight actually changing |
| **Human?** | Fully automatable |
| **Recipe** | Same capture + compositor, new spec |
| **Build state** | **T1** |
| **Cuts** | 21-26s TikTok · 7-12s IG loop (the number ticking) · YouTube Short |
| **Hook** | Playbook §2 #6: "Hit your reps, it adds 5 lbs. Miss them badly, it takes 10% off. That's the whole algorithm." |
| **Cost** | ~$0.35 · **Time** ~45 min |
| **Freshness** | ~8 videos |
| **Hard guardrail** | **Do not show or imply a calendar-based deload.** See the stale hook-library line flagged above |

### U5 — Build-in-Public: the Google Health Declaration fight

| | |
|---|---|
| **Job** | Hook a developer audience. Slow burn, deliberately low priority |
| **Source** | 100% true and fully documented: Google's health-declaration page enumerates **47** `android.permission.health.*` entries because it is still reading version code 2's manifest, while the shipping v3 `.aab` contains exactly **4** — `READ_STEPS`, `READ_HEART_RATE`, `READ_ACTIVE_CALORIES_BURNED`, `WRITE_ACTIVE_CALORIES_BURNED`, extracted with Python's `zipfile` and read directly |
| **Human?** | Fully automatable (rendered code/terminal capture) |
| **Recipe** | Render the extracted manifest and the Console page as HTML → Playwright screenshot loop → punch-in on 47 vs 4 → Heath clone VO → compositor |
| **Build state** | **T2** — needs a code/terminal capture recipe |
| **Platforms** | **X and Reddit primarily**, YouTube Short secondary. Not TikTok's audience |
| **Cost** | ~$0.35 · **Time** ~40 min |
| **Freshness** | Event-driven, ~6 real chapters exist (the health scanner, the 14-day review wait, the iPad-screenshot rejection, the LLC, the UPS box, the silently-dead Codemagic webhook) |
| **Priority caveat** | Aggregate blog claim: solo build-in-public accounts take **6-12 months of daily posting** to reach 1,000 followers ([SoftwareSeni, 2026](https://www.softwareseni.com/building-in-public-the-10-year-distribution-strategy-behind-solo-founder-revenue/)) — unsourced, but the timeline shape is a poor fit for a pre-launch push. **Cap at 1 text post/week and 1 video/month.** Do not let this crowd out U1-U3. Also note: Reddit self-promo gets you banned fast — participate for weeks first, and **never automate it** |

### U6 — Equipment Reality Check

| | |
|---|---|
| **Job** | Hook cold, using constraint-framing |
| **Source** | `Rust/src/constants/equipmentCatalog.ts` — **121 items across 10 categories as of 2026-09-08. Count it, never quote it from memory** (this file previously said 122 and the wrong number shipped into drafts) |
| **Human?** | Fully automatable |
| **Recipe** | Capture the real catalog scrolling and a one-tap preset → the workout it actually builds → Heath clone VO → compositor |
| **Build state** | **T1** |
| **Cuts** | 21-30s TikTok · 8-12s IG loop · YouTube Short |
| **Hook** | Playbook §2 #1: "One guy. 121 pieces of equipment. Zero funding." |
| **Cost** | ~$0.35 · **Time** ~45 min |
| **Freshness** | ~10 equipment scenarios (hotel gym, garage, bands only, full commercial, a single adjustable bench) |
| **Why constraint-framing** | The best-supported fitness-content finding available: mistake-correction and myth-busting hooks are the most-used and **"showing signs of saturation,"** while constraint-framing ("best split if you can only train 3 days") is **underused relative to performance** ([Draper, 2026](https://draper.chat/blog/tiktok-fitness-hooks-2026) — blog-aggregated, not primary research, but it's the only directional read available and it points away from what everyone else is doing) |

### U7 — Founder Story, Heath on camera — **one asset, not a format**

| | |
|---|---|
| **Job** | Trust. A pinned profile asset |
| **Human?** | **Needs Heath**, plus his explicit script approval — `conv-founder-val.json` is flagged *"HEATH MUST APPROVE THIS SCRIPT BEFORE IT RENDERS OR POSTS"* |
| **Guardrail** | Heath is a 100% disabled veteran. On a fitness app that is real and relevant, and it is also the easiest thing in the plan to get wrong. Handling rules are in `docs/RUST-PRELAUNCH-MARKETING-PLAN.md` §5, and the final call on framing is always Heath's |
| **Freshness** | **One. It does not repeat.** Listed here so nobody plans a weekly slot around it |

---

## 5. Build order — ranked by reach per unit of effort

### 5.1 — FIRST: generalize the compositor · `build-rust-shortform-video.py` → `build-shortform-video.py`

**This is not a format. It is the substrate underneath nine of them** — D1, D2, D4, D6, D7, U1, U2,
U4, U6, and R2 — and it is the highest-leverage change available by a wide margin.

The script already passes all 16 machine-checkable §5a gates. What is Rust-specific is only the
constants and a few hardcoded strings:

- `SRC_W, SRC_H = 1170, 2532` and the literal `2080` window height in `geometry_filter()` — must
  come from the frames JSON so a desktop capture (Dossie), a PDF page render (TREC forms), or an
  HTML render (net sheets) can feed the same pipeline.
- Hook-card palette, caption style, CTA card text and URL — must come from a per-brand config
  (Rust dark theme / Dossie Blush+Navy+Coral / realtor sage+cream + the TREC attribution block).
- Voice resolution — must route through `scripts/voice-select.js` by `target_owner` rather than
  being assumed, so the clone-never-speaks-as-Dossie rule stays enforced in code.
- The CTA guardrail already in `generate-conversation-video.js` (refusing a download CTA for Rust)
  belongs here too, plus a `/founding` refusal for Dossie.

**Effort:** one focused session. **Unlocks:** ten formats across all three brands.

### 5.2 — SECOND: D1, the Ask-Dossie Real-Question Demo generator

Highest reach-per-effort of any single format. The recorder exists, the capability allowlist exists
and is current, it feeds **all five** live Dossie destinations, and it has ~40 videos of runway
before it repeats. The only net-new work after §5.1 is swapping `recordVideo` for the screenshot
loop and writing the question→capability mapper.

### 5.3 — THIRD: R1, the Listing Reel auto-trigger

Nearly free, and it feeds Heath's actual income. The entire chain already works — live connectMLS
read, verified fact pack, compliance gate, Ken Burns renderer, TREC card, Telegram approval, Zernio.
The only missing link is firing the video build from the same atomic run that generates the copy, so
a video can never be built off a stale price. ~18 videos of runway at 3 active listings.

**Then, in order:** U1 spec-template (a proven pipeline, just needs a repeatable spec generator) →
D2 quote→capability mapper → R2 TREC explainer → U3 split-screen mode → R5 net-sheet anonymizer.

---

## 6. Formats killed by the research, and why

Each of these is either running today or was an obvious thing to reach for. Every one is cut.

| # | Killed | Why | Source |
|---|---|---|---|
| 1 | **All static image cards**, every brand | Already Heath's standing call. The number behind it: the 702 Fawndale static Instagram post got **54 views, 1 like**. Static listing photos are the most algorithmically suppressed format on Meta right now — video reaches non-followers, static reaches a fraction of existing ones | `feedback_video-only-no-static-cards.md` |
| 2 | ⚠️ **AI-persona text posts on LinkedIn** (Brenda / Patricia / Victor) — **running in production today via `cron-generate-posts.js`** | LinkedIn's March 2026 "Authenticity Update" algorithmically suppresses generic/templated AI content beyond the first-degree network, with a reported **30-55% reach and engagement penalty**. Rotating LLM-written persona copy is precisely the target | [Neil Patel, 2026](https://neilpatel.com/blog/linkedin-ai-slop-crackdown-content-strategy/) · [ALM Corp, 2026](https://almcorp.com/blog/linkedin-feed-algorithm-update-llm-2026/) |
| 3 | ⚠️ **Link in the first comment** — the current instruction in `docs/REALTOR-PAGE-CADENCE.md` | On LinkedIn this cuts visibility by **up to 80%**. An external link in the post body costs 18.8% of median reach. Both are worse than no link at all. Use a profile/bio link and let the CTA be spoken | [van der Blom via Dataslayer, Feb 2026](https://www.dataslayer.ai/blog/linkedin-algorithm-february-2026-whats-working-now) |
| 4 | **LinkedIn polls** | Collapsed to **0.07% engagement** after the March 2026 Authenticity Update — effectively zero | same |
| 5 | **Full-length property walkthrough tours** as organic social | Not dead, but the format that still works is a **20-45s cut**, not the 2-4 minute tour. R1 is already built to this shape. (No hard platform data either way — treat as directional) | [Luxury Presence, 2026](https://www.luxurypresence.com/blogs/real-estate-video-marketing/) · [AutoReel, 2026](https://www.autoreelapp.com/blog/7-types-of-real-estate-videos-every-agent-should-be-posting-in-2026) |
| 6 | **Facebook as a growth surface** | Organic Facebook reach for *new-audience* growth is described as "effectively dead" in 2026, repeated independently across sources. Keep FB — it is Heath's warm network and it converts people who already know him — but **stop counting FB posts as reach** in any plan | [Momenzo, 2026](https://www.momenzo.com/blog/real-estate-social-media-trends) |
| 7 | **Rust "coming soon" / countdown / feature-list teasers** | No evidence they work, and they burn pre-launch impressions that should be converting to a waitlist instead. The warning that survives: the payoff has to match the hype, and a countdown needs supplementary content to carry it | [Voxturr, 2025](https://voxturr.com/pre-launch-marketing-guide-build-buzz-before-launch-in-2025-strategies/) |
| 8 | **Rust transformation / before-after** | Heath has no before/after and must not fake one. The honest version is already hook #34: *"I'm not going to show you a before/after. I'm going to show you the coach adjusting my actual workout."* | `docs/RUST-PRELAUNCH-MARKETING-PLAN.md` §4 Tier 3 |
| 9 | **Fitness myth-busting / mistake-correction hooks** | The most-used fitness hook family and **showing signs of saturation**. Replaced by constraint-framing in U6 | [Draper, 2026](https://draper.chat/blog/tiktok-fitness-hooks-2026) |
| 10 | **Plain "Just Sold" graphics with no story** | Listing-flyer and sold-graphic posts with no personality are named as saturated and numbing. R6 survives only because a real line about the deal is attached, and only at one post per close | [Momenzo, 2026](https://www.momenzo.com/blog/real-estate-social-media-trends) · [aihomedesign, 2026](https://aihomedesign.com/blog/real-estate-marketing/real-estate-social-media-marketing/) |
| 11 | **In-video Reels link stickers as the CTA** | Meta gated on-video Reels link stickers behind paid "Meta Verified for Business" in 2026. Reels captions still carry no clickable link. **Stories link stickers remain free** and reportedly convert better same-session than bio-link traffic — that's the workaround | [Social Media Examiner, 2026](https://www.socialmediaexaminer.com/what-clickable-reels-links-and-hashtag-limits-mean-for-your-2026-instagram-strategy/) |
| 12 | **Generative AI b-roll (Kling) for real property footage** | Already banned in `generate-listing-video.js` for a good reason — models warp architecture between frames and that is a misrepresentation risk on a TREC-regulated ad. The research adds a second reason: AI-disclosure obligations and probable ranking cost (§7) | in-repo + §7 below |
| 13 | **Color-card "conversation" videos as a final deliverable** (`generate-conversation-video.js` output) | Verified failure, not a guess: frame 0 and frame 1.5s are **pixel-identical** in every video checked, runtimes of 35.9-42.6s sit above the completion band, and every cover is a byline rather than a hook. **Keep the script** — its TTS routing, brand guardrails and CTA refusals are good and reused. Never ship its *visual* output again | `docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md` §6 |

**Two research findings I am deliberately NOT acting on**, because the sources don't support it:
the widely-repeated *"video listings generate 403% more inquiries"* figure appears verbatim across
dozens of blogs with no traceable primary citation, and the *"talking head builds personal brand
3-5× faster"* claim is unsourced. Neither is used to justify anything above.

---

## 7. AI disclosure — a live compliance exposure, not a hypothetical

Every format in this library that uses Heath's cloned voice is **AI-generated audio**, which both
YouTube and TikTok now require to be labeled.

- **YouTube** requires disclosure of AI-generated/synthetic voices and faces (policy live since
  2025, enforced through 2026). Undisclosed content caught by classifiers gets reduced distribution
  or removal; repeat offenses can reach Partner Program status.
  [Eliro, 2026](https://eliro.pro/blog/youtube-ai-content-policy-faceless-creators-2026)
- **TikTok** requires an AI label on AI-generated or substantially-AI-edited video, with C2PA
  detection and an "AIGC" label in 2026.
  [Auditsocials, 2026](https://www.auditsocials.com/blog/tiktok-ai-content-disclosure-rules-2026) ·
  [SocialScale Hub, 2026](https://www.socialscalehub.com/academy/ai-content-disclosure-rules-2026-tiktok-instagram-youtube)
- **The uncomfortable part:** platforms officially state that *disclosed* AI content isn't ranked
  down, while independent analysis claims labeled synthetic content is quietly deprioritized against
  "authentic" footage. That specific reach-penalty claim is an industry-observation piece, **not**
  platform-confirmed.
  [influencers-time.com](https://www.influencers-time.com/ai-video-disclosure-labels-trigger-a-reach-penalty-brands-mu/)

**What this means for the library, concretely:**
1. Disclose on YouTube and TikTok for every video carrying a cloned or synthesized voice. Disclosure
   is cheap; an enforcement action is not.
2. It is a real argument for putting **Heath's actual recorded voice** on the highest-stakes assets —
   R3, D3, U7 — rather than the clone. The clone is for volume; his real voice is for the videos
   that have to be believed.
3. It is a second, independent reason to keep generative b-roll out of listing content.

*(EU AI Act Article 50(4) mandates deepfake/AI-content disclosure from 2026-08-02 with penalties to
€15M / 3% of global turnover. Not US-applicable today — noted only because Rust's iOS listing
already removed the EU 27 territories.)*

---

## 8. The weekly production plan

### 8.1 — Weekly output: 7-8 masters → ~21 live posts

| Brand | Masters/wk | Formats drawn | Cuts each | Live destinations | Posts/wk |
|---|---|---|---|---|---|
| **Realtor** | 3 | R1 (weekly) · R2 (weekly) · R3 or R4 or R6 or R5, rotating | 3 | FB, IG, YouTube | **9** |
| **Dossie** | 3 | D1 (weekly) · D2 (weekly) · D3 / D4 / D7 / D6, rotating | 4-5 | FB, IG, X, LinkedIn, TikTok | **12** |
| **Rust** | 2 | U1 or U2 · U3, with U6 / U4 / U5 rotating in | 3 | **none yet** | **0** (banked) |
| | **8** | | | **8 live destinations** | **~21** |

The moment Rust accounts exist, the same 2 masters × 3 destinations adds **6 posts/week for zero
extra production**, taking the total to ~27.

Platform caps in `posting_schedule` are nowhere near binding: FB 2/day, X 3/day, IG 1/day,
LinkedIn 1/day, TikTok 1/day is 40 slots a week against a 21-post plan. **The constraint has never
been the schedule. It has always been supply.** That is the whole point of this document.

### 8.2 — The rotation, and why nothing exhausts

Draw rate against runway, per format:

| Format | Runway | Draw | Weeks to exhaustion | Refresh input |
|---|---|---|---|---|
| R1 Listing Reel | 18 | 1/wk | 18 | A new listing |
| R2 TREC Explainer | ~20 | 1/wk | 20 | A TREC form revision · a real deal question |
| R3 FAQ on camera | unlimited | 1/wk | ∞ | **Heath, 20 min every 2 weeks** |
| R4 Local | 12-15 | 0.3/wk | 40+ | Each trip he takes |
| R5 Offer Desk | event | 0.25/wk | ∞ | Each received offer |
| R6 Just Sold | event | 0.25/wk | ∞ | Each MLS status change |
| R7 Market Check | 12/yr | monthly | ∞ | The calendar |
| D1 Ask Dossie | ~40 | 1/wk | 40 | A newly shipped, re-verified feature |
| D2 Reddit Pain | unlimited | 1/wk | ∞ | **The scraper, running from Heath's machine** |
| D3 Founder camera | ~6 | 0.3/wk | **20** ⚠️ | **A new verified war story — only 2 exist** |
| D4 Deadline Math | ~15 | 0.3/wk | 50 | A new real deadline trap |
| D6 Coordinator | ~8 | 0.15/wk | 50+ | New pipeline scenarios |
| D7 Watch It Flag | ~10 | 0.3/wk | 33 | Each new sample contract |
| U1 Readiness | 24 | 0.5/wk | 48 | A new coach or conversation |
| U2 One Sentence | 15 | 0.3/wk | 50 | New sentences |
| U3 Coach vs Coach | very high | 1/wk | 60+ | New questions — the deepest well here |
| U4 Progression | 8 | 0.2/wk | 40 | — |
| U5 Build in Public | ~6 | 0.25/wk | 24 | Each new platform fight |
| U6 Equipment | 10 | 0.3/wk | 33 | New equipment scenarios |

**Nothing exhausts inside four months at this draw rate**, and the three self-refilling formats —
R3 (real questions), D2 (the Reddit scraper), R5/R6 (his actual deals closing) — mean the library
does not have a hard end date. The one real cliff is **D3 at ~20 weeks**, and it is a content
problem, not an engineering one: Heath has only told us two true stories.

### 8.3 — The week, laid out

| Day | Produced (unattended overnight) | Posted |
|---|---|---|
| Mon | D1 capture + render | Realtor R2 → FB/IG/YT · Dossie D2 → all 5 |
| Tue | R1 live MLS read + render | Realtor R1 → FB/IG/YT · Dossie D1 → all 5 |
| Wed | U1/U2 capture + render | Realtor R4 or R6 → FB/IG/YT |
| Thu | D2 scraper pull + mapper + render | Dossie rotating slot → all 5 |
| Fri | U3 capture + render | Realtor R3 → FB/IG/YT · Rust (banked until accounts exist) |
| Sat | R2 form render | Realtor rotating slot |
| Sun | — | Dossie rotating slot |

Every post still routes through the existing Telegram approve/reject flow before it goes live.
Nothing in this plan bypasses that gate.

---

## 9. What genuinely needs Heath

Ordered by how much it blocks.

| # | What | How often | Blocks |
|---|---|---|---|
| 1 | **Rust: buy the domain, ship the waitlist, create the social accounts** (phone verification) | **One time, ~1 hour** | **100% of Rust distribution.** Two of the eight weekly masters have nowhere to go until this exists |
| 2 | **On camera, one sitting every 2 weeks, ~20 minutes** — 4 realtor FAQ answers + 3 Dossie founder clips | Every 2 weeks | R3 and D3 entirely — which is to say, every format whose job is *trust*. Nothing else substitutes |
| 3 | **Tell us a new true story when one happens** — and it gets written into `heath-verified-war-stories.md` the same day | Opportunistic | D3 past ~20 weeks. This is the only hard cliff in the library |
| 4 | **Approve every post via Telegram** | ~5 min/day | Everything. Existing flow, unchanged |
| 5 | **Decision: LinkedIn document carousel** (§D5) — his "no cards" rule vs. the only large-sample study we have, which says it's the top LinkedIn format at 2-3× reach | One time | D5 only. Written down, deliberately unbuilt |
| 6 | **Decision: connect realtor TikTok / X / LinkedIn?** Three destinations sitting unused while the content to fill them already renders | One time | ~9 extra posts/week for zero extra production |
| 7 | **Phone b-roll of Boerne / Hill Country**, whenever he's out | Opportunistic, ~10 min | R4 |
| 8 | **Approve the Rust founder-story script** before it renders — explicitly flagged in `conv-founder-val.json`, and the final call on the veteran framing is always his | One time | U7 |
| 9 | **Reply to comments on Rust**, in his own voice | Daily once posting starts | The cheapest ranking signal there is, and it cannot be automated without looking like a bot |
| 10 | **Reddit participation** for U5 | Weeks of lurking before any post | U5's distribution. Automated Reddit self-promo is the fastest possible ban |
| 11 | **Source more licence-clean music** — `Media/Music/` has two tracks for three brands | One time | Nothing hard-blocks, but eight videos a week across two tracks will sound repetitive within a month. ElevenLabs music generation is not on our key; Pixabay's CDN throttles hard |

**Everything else runs unattended:** MLS reads, photo assembly, capture, render, caption burn-in,
voice synthesis, music ducking, the compliance gate, queueing, and the §5a machine-checkable
quality gate.

---

## 10. Open verification items

Named here so they don't get lost. None blocks a build; all should close before scale.

1. **TREC size ratio on the listing closing card.** The rule requires the broker name at ≥ half the
   size of the largest agent contact info. `TREC_ATTRIBUTION` carries the right string; the rendered
   type sizes have never been measured against the rule.
2. **`marketing/rust-hook-library.md` line 1 says "deload every 5th week."** Code-verified reality
   is a per-exercise 10% back-off after missed reps and **no calendar deload**. Fix the file before
   any generator reads from it.
3. **`heath-voice-clone-usage-scope.md` reads as a flat "never Dossie."** The operative rule, per
   the playbook and per `voice-select.js`, is narrower: the clone may speak **as Heath** in Dossie
   founder/instructional content, never **as Dossie**. Reconcile the wording.
4. **Realtor YouTube has a connected destination and no content plan** (`docs/PIPELINE.md`) — zero
   `social_posts` rows exist for `platform=youtube` at all. R1/R2/R7 fill it; someone has to wire
   the routing.
5. **Dossie Settings still labels E-Signatures "COMING SOON"** while the roadmap page says it's live
   and the dossier UI has a working send modal. Three surfaces disagreeing is a marketing-claim
   hazard as much as a UI bug.
