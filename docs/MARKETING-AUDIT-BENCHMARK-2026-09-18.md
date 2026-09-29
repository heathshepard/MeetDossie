# Marketing audit — competitive benchmark, 2026-09-18

Why our reels get double-digit views while accounts in our lanes get hundreds of thousands. Evidence
first, theory second. Every number below is either pulled from a live page/DB on 2026-09-18 or cited
to a dated source. Where a claim could not be verified it says so.

Tooling limits: no browser extension and no Playwright Chromium in this session. TikTok profile and
video pages were read via curl (the SSR JSON exposes `followerCount`, `playCount`, `shareCount`,
`duration`, `createTime`, cover frame). YouTube channel/Shorts pages were read the same way.
Instagram pages cannot be fetched anonymously; IG follower counts below are from third-party
articles and are marked as such. Cover frames of benchmark videos were downloaded and visually
inspected to confirm face-on-camera and on-screen text.

---

## 0. Our baseline (live data, 2026-09-18)

**Supabase `post_analytics` (latest sync per post, all history):**

| Platform | Posts tracked | Avg views | Median views | Max views | Avg likes | Avg shares | Avg saves |
|---|---|---|---|---|---|---|---|
| Instagram | 44 | 3 | 2 | 31 | 0.2 | 0.00 | 0.00 |
| Facebook | 131 | 1 | 0 | 168 | 0.0 | 0.00 | 0.00 |
| LinkedIn | 99 | 0 | 0 | 0 | 0.0 | 0.00 | 0.00 |

**TikTok `@meetdossietc` (curl of profile, 2026-09-18):** 7 followers, 5 total likes, 13 videos.

**Posting cadence, `social_posts.status='posted'`, by month:**

| Month | FB | IG | LinkedIn | TikTok | Twitter | Posts with Heath's recorded voice |
|---|---|---|---|---|---|---|
| May | 30 | 6 | 7 | 0 | 13 | 0 |
| Jun | 57 | 21 | 29 | 0 | 61 | 0 |
| Jul | 21 | 30 | 17 | 0 | 5 | 0 |
| Aug | 13 | 4 | 12 | 1 | 7 | 0 |
| Sep (to 18th) | 46 | 4 | 35 | 0 | 10 | 0 |

`heath_voice_recorded_at` is null on every posted row in 120 days; `uses_cloned_voice` is true on 11
Aug-Sep posts. Instagram — the one platform where short-form reach actually happens for this niche —
dropped from 30 posts in July to 4 in August and 4 in September.

**What our videos look like** (inspected `Media/shortform-2026-09-16/cover-dossie-d1-ask-deadline.png`
and `Media/feature-demos/feature-demo-chase-documents-desktop-2026-09-07.mp4`): navy background,
brand wordmark, a typeset text card ("I asked Dossie one deadline question. Watch her read it off
the contract."), then a 1920x1080 screen recording of the app with an ElevenLabs voice (Bill or
Luna) narrating. No human, no face, no phone footage, no captions burned over speech, 33 s.
`docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md` already says of the Rust cuts: "a static black-background
text-card slideshow with no motion." The Dossie cuts are the same shape with a screen recording
after the card.

That is the object being compared below.

---

## 1. Accounts genuinely winning in our lanes

Follower/video counts read live from platform JSON on 2026-09-18 unless marked. "Typical views" =
what I could measure, not the account's own claims.

### Lane (a) — real-estate-agent education / tools / TC

| # | Account | Platform | Followers | Videos | Typical views/video (measured) | Cadence | 3 measured top videos |
|---|---|---|---|---|---|---|---|
| 1 | **Tat Londono** `@tatlondono` — RE coach, sells coaching | TikTok | 2,700,000; 58.7M likes | 1,206 | 68k-132k on the 3 sampled | not published; 1,206 videos on a ~5-yr-old account ≈ 4-5/wk | "A day in the life of a real estate agent: NYC edition" 131.5k views, 39 s (Feb 2025); "22 years in real estate. And rookies still think they can interview me" 71.6k, 85 s (Aug 2025); "How to become a real estate agent!" 68.7k, 48 s, 215 shares (Apr 2025) |
| 2 | **Glennda Baker** `@glenndabaker` — Atlanta agent, storytelling | TikTok | 867,300; 17.4M likes | 1,130 | 10k-104k on 6 sampled; one at 598.7k | daily (NAR, 2022: started 2/wk, went daily; batches 30+ in one monthly shoot) | "If you're wondering what I do…" 598.7k views, 55 s, 263 comments (Oct 2023); "So what's the solution to active under contract?" 103.8k, 64 s, 222 shares (May 2026); "I know it's hard for you to believe since we don't have a ping pong table…" 33.7k, 49 s, 232 shares |
| 3 | **The Broke Agent** `@thebrokeagent` (Eric Simon) — memes for agents; BAM media co | Instagram (primary) | ~330-350k (Inman/podcast bios, not live-verified) | — | IG not fetchable | — | TikTok mirror is small: 16,500 followers, sampled meme video 1,274 views. Memes did not port to TikTok. |
| 4 | **Coffee & Contracts** `@coffeecontracts` (Haley Ingram) — SaaS/templates sold TO agents, ~5,000 members | Instagram (primary) | 129k (search snippet of IG page, not live-verified) | — | IG not fetchable | — | YouTube mirror: 5,830 subs, Shorts first-page median 155 views, best 1.5k. Same content, wrong platform = our numbers. |
| 5 | **Brandon Mulrenin** `@BrandonMulrenin` — Reverse Selling coach | YouTube | 176k subs; 19.0M views; 2,325 videos | 2,325 | Shorts first-page median 1,100 | ~3-4/wk (2,325 videos over 13 yrs incl. long-form) | Shorts: "Realtors This Cold Call Opener Works 85% of the Time" 6.2k; "This Question Stops the Commission Fight" 4.3k; "this line ends 'Think It Over'" 4.1k |
| 6 | **Loida Velasquez** `@LoidaVelasquez` — agent educator | YouTube | 97.4k subs; 6.28M views | 629 | Shorts first-page median 1,200 | — | "How I Got Over the Fear of Cold Calling" 2.2k; "Easy Trick to Stop Using Filler Words" 2.2k; "When sellers are delusional about their home price" 1.8k |
| 7 | **Kyle Handy** `@KyleHandy` — San Antonio coach (local to us) | YouTube | 46.5k subs; 2.1M views | 374 | Shorts first-page median 854 | — | "Should you join your local chamber of commerce?" 4.5k; "How to win over FSBO" 3.3k; "Can an unlicensed assistant earn a commission?" 2.3k |
| 8 | **Coach Milan J** `@milan_tccoach` — TC business coach | TikTok | 1,414 | — | 4.3k on the one indexable video | — | "How much does a Transaction Coordinator make?" 4,298 views, 72 s, 8 shares (Mar 2023) |
| 9 | **Lexi Barraza** `@lexi.barraza` — TC tips | TikTok | 1,228; 11.4k likes | 178 | not indexable | 178 videos | — |

Finding for lane (a): the **TC-specific** lane is tiny (two creators, 1.2k-1.4k followers). Nobody is
winning at "transaction coordination" content. The big numbers are **agents/coaches talking to
agents about the job** (Tat, Glennda), and they win on TikTok/IG, not YouTube Shorts — the same
coaches' Shorts sit at ~1k median even with 100k-580k subscribers (Tom Ferry: 580k subs, Shorts median
991).

### Lane (b) — B2B founders selling to a professional niche via short-form

| # | Account | Platform | Followers | Typical views | Cadence | Evidence |
|---|---|---|---|---|---|---|
| 10 | **Dan Martell** `@danvmartell` / `@danmartell` — SaaS coach | TikTok 1.9M (29.8M likes, 3,039 videos); YouTube 3.07M subs, 403.6M views, 3,707 videos | Shorts first-page median 26,000; TikTok samples 16.8k-63.8k | multiple/day (3,039 TikToks + 3,707 YT uploads) | Shorts: "Whats the best AI tool right now?" 172k; "Are you keeping or cutting these AI tools in 2027?" 105k; "10 things to avoid if you want to be wealthy" 93k. TikTok: "Fastest way to make money" 63.8k/26 s; "When you say you build AI companies" 62.3k/15 s/93 shares. Claims "36 million impressions on content last month" and 1M followers in 12 months (videohighlight summary of his own YT video). |
| 11 | **Natural Write** (Nikita + Yini) — AI writing SaaS | TikTok | — | 9M views in 90 days | 1 video/day for 90 days, no misses | 300k site visits, 250k signups, $100k revenue in 90 days; format = screen recordings + comedy bits copied from already-viral formats, <30 s; paid influencers "flopped," in-house daily posting worked (Postiz case study). |

### Lane (c) — pre-launch / early fitness & AI-coach apps

| # | Account / app | Evidence |
|---|---|---|
| 12 | **Cal AI** (Zach Yadegari, Blake Anderson) | Founder's own TikTok `@zachyadegari` is only 10,400 followers / 65 videos. Growth did not come from the founder account. It came from paying two unknown TikTok creators $50 each → "5-10 million views… 45,000 downloads in that first big day, 200,000 downloads on that week" (Better Launch interview), then in-house UGC-style content iterated "on hooks and formats until they find a winner that can be scaled across dozens of accounts," then paid. $30M revenue in 2025, sold to MyFitnessPal (CNBC 2025-09-06; getlatka). |
| 13 | **Stronger** (gamified workout tracker) | 200-300M views, 1.2M users, $600k ARR. Founders Peter and Jack on camera; "slightly rough, authentic TikTok content consistently outperforms polished ads"; one 6-second "fade-in" format replicated 300+ times across multiple accounts with micro-variants (Superwall case study). |

---

## 2. Dissection of the top videos

Cover frames downloaded from TikTok and inspected. "Spoken hook" is only listed where a transcript
or on-screen caption was visible; otherwise marked unverified.

| Video | First 2 s (verified from cover/caption) | On-screen hook | Length | Real person on camera | Production | Captions | CTA | Caption/hashtags |
|---|---|---|---|---|---|---|---|---|
| Tat Londono "22 years in real estate…" 71.6k | Extreme close-up selfie, wide-eyed, mid-sentence | Boxed TikTok-style text: **"WTF IS THE MATTER WITH YOU!"** | 85 s | Yes, phone selfie, curtains at home | Phone, native TikTok text box, no edit | Native text overlay | None visible | Caption is the hook line + 1 emoji; no hashtags |
| Tat Londono "A day in the life… NYC" 131.5k | Back seat of a car, talking, fur coat | Boxed text: **"A DAY IN THE LIFE OF A REAL ESTATE AGENT"** | 39 s | Yes, phone, in car | Phone, native text | Native | None | 5 hashtags (#realestateagent #realtor #nyc…) |
| Tat Londono "How to become a real estate agent!" 68.7k, 215 shares | (cover not pulled) | — | 48 s | Yes (per account pattern) | Phone | — | — | Doubled hashtags (##realestate##millionaire##money) |
| Glennda Baker "If you're wondering what I do…" 598.7k, 263 comments | Sitting at kitchen island, glasses, talking, no text | none — she is mid-story | 55 s | Yes, static phone at home | Phone, zero edit, original sound | none | None | "If you're wondering what I do…" + 5 brand hashtags (#GlenndaBaker #GoogleGlennda #GlenndaTok) |
| Glennda Baker "solution to active under contract?" 103.8k, 222 shares | Studio, Shure mic, blue star t-shirt, hands moving | Burned-in word-by-word captions ("my solution is") | 64 s | Yes | Edited (studio, mic, captions) — her later era | Karaoke-style | None | Question caption + #DearAbbyOfRealEstate series tag |
| Dan Martell "Fastest way to make money" 63.8k | Documentary b-roll of two kids at a networking event, yellow caption | Captioned dialogue ("I WAS WONDERING") | 26 s | Yes (him + subjects), filmed by a crew | Pro-edited, colour-graded, captions | Bold yellow boxed | None in first frame | 5-word caption, no hashtags |
| Dan Martell "When you say you build AI companies" 62.3k, 93 shares | (cover not pulled) | — | 15 s | Yes | Edited | — | — | Meme-format hashtag joke |
| Coach Milan J "How much does a TC make?" 4.3k | Talking head at home desk, title card over head | Title card **"How much does a Transaction Coordinator make"** + emoji | 72 s | Yes, webcam quality | Phone/webcam, letterboxed (black bars top & bottom) | none | none | 3 hashtags |
| The Broke Agent "Ok buddy" 1.3k (TikTok) | Meme: text over 20th-Century-Fox parody "I DON'T GIVE A F***" | Text-only meme | 20 s | No | Template meme | n/a | none | 2 words |
| **Ours** "I asked Dossie one deadline question" | Navy typeset card, wordmark, no motion, no person | Typeset headline | 33 s | **No** | Rendered (Creatomate/HTML card + screen recording), synthetic voice | none over speech | implied product pitch throughout | (n/a — 2 IG views) |

Pattern across every video above 50k views: a real, recognisable person is on screen in frame one,
talking, usually phone-shot, with either a big native text box stating a provocative claim or no text
at all because the person is already mid-story. Zero of them open on a brand card. Zero pitch a product
in the opening. All use **original sound** (verified `"original":true` on every TikTok sampled).

The only faceless account in the set that works (The Broke Agent) works on **Instagram with memes**
and dies on TikTok (16.5k followers, ~1k views) — and memes are still a human voice, just typed.

---

## 3. What separates them from a synthetic-voice product demo

Ranked by how much evidence supports it.

1. **A human face, talking, in frame one.** Every >50k video sampled has one. Peer-reviewed support:
   Yang, *Behavioral Sciences* 2026 (N=656 and N=769, between-subjects) — a human presenter vs an AI
   avatar raised trust from 3.78 to 4.63 (η²=0.082) and purchase intention from 3.75 to 4.21; the
   mechanism was "perceived creator responsibility and effort." The IJRM 2025 face-presence paper
   (Elsevier, S0167811625000096) finds face presence helps in product-review / livestream / creator
   contexts and hurts only in trailer/destination-style content — i.e. exactly our category benefits.
   A 7,431-video creator dataset (thecontentlabs.app, 2026) puts face-on-camera median views at 1.9x
   faceless (12,503 vs 6,630). No credible large-sample industry report (Buffer/Sprout/HypeAuditor)
   with a clean face-vs-faceless split exists; the "faceless gets 3x engagement" line circulating in
   2025 comes only from AI-video vendor blogs (vidboard.ai, steve.ai) and should be ignored.
2. **Story or opinion, not a feature.** Glennda's 598k video is "If you're wondering what I do…" —
   a story about her job. Tat's is "rookies still think they can interview me." Neither shows a
   tool. Tom Ferry's own 2026 guidance: "start with immediate payoff rather than introductions."
   Our opening is an introduction ("I asked Dossie…").
3. **Volume and repetition of one winning format.** Natural Write: 1/day for 90 days. Stronger: one
   6-second format replicated 300+ times. Glennda: 30+ shot in one sitting, posted daily. Buffer
   (11.4M TikToks, Oct 2025): 2-5 posts/week gets up to +17% views/post vs 1/week; 11+/week +34%,
   and the 90th-percentile view count rises from 3,722 to 14,401. We posted 4 Instagram videos in
   August and 4 in September.
4. **They never pitch in the video.** None of the sampled top videos has a CTA in frame; the offer
   lives in the bio (Tat: coaching; Glennda: her team; Coffee & Contracts: link). Ours is a product
   demo with the product name in the first line.
5. **Phone-native production.** Tat's 2.7M-follower videos are a phone selfie with the native TikTok
   text box. Stronger: "slightly rough, authentic… consistently outperforms polished ads." Our
   render is polished in exactly the way that signals "ad."
6. **Platform policy now penalises our shape directly.** YouTube's July 15 2025 "inauthentic
   content" rule targets mass-produced/templated video with no unique human-added value; Instagram
   (Apr 2026, PetaPixel/Tubefilter) removes non-follower recommendations from accounts that post
   unoriginal content. A cron that renders text cards + stock/screen footage + TTS is the pattern
   these policies describe.

Synthetic voice specifically: no platform-level dataset isolates TTS vs human voice. The 2026 human-
vs-AI-presenter study above is the closest controlled evidence and it is one-directional. Treat the
voice as a symptom: the problem is that there is no person, and the voice is how a viewer confirms it
in the first second.

---

## 4. Distribution mechanics that matter now (2025-26)

- **Instagram Reels ranking = watch time, likes per reach, sends per reach** (Mosseri, Jan 2025
  series; paraphrased, primary video not fetchable). Instagram's own ranking doc: reels ranked on
  "how likely you are to reshare a reel, watch a reel all the way through, like it"
  (about.instagram.com, "Instagram Ranking Explained"). Our avg shares: 0.00.
- **Hashtags do not drive reach** on Instagram (Mosseri, widely reported; the official ranking doc
  never mentions hashtags as a reach factor). Note Tat's 131k video has 5 hashtags and her 71k one
  has none; Dan Martell's use none.
- **Originality gate:** Instagram down-ranks content "already been posted on Instagram" and since
  Apr 2026 removes recommendation eligibility for repost-heavy accounts (PetaPixel/Tubefilter
  2026-04-30). YouTube "inauthentic content" monetisation rule, 2025-07-15.
- **Trial Reels** (1,000+ followers): shows a reel to non-followers first (Instagram Help Center).
  We are under 1,000 on every account, so this is not available to us yet.
- **TikTok** weights strong signals ("whether a user finishes watching a longer video from
  beginning to end") over weak ones; follower count is explicitly not a ranking factor (TikTok
  Newsroom, "How TikTok recommends videos #ForYou"). Original sound: every sampled winner used it.
- **YouTube Shorts:** since 2025-03-31 every play counts as a view; "Viewed vs swiped away" is the
  metric YouTube exposes. Measured reality for our niche: coaches with 100k-580k subs get ~1k median
  Shorts views. Shorts is the wrong primary surface for agent-education content.
- **Cadence:** Buffer 2025 numbers above. Social Insider (Feb 2026, 35M posts): Instagram accounts
  with 1-5k followers average 580 views per reel, 5-10k average 1,000. Our median is 2. That gap is
  not an algorithm penalty on a small account — 1-5k accounts get 580 — it is content that the first
  test cohort does not watch.
- **The 3-second hold / "hook rate":** real as a metric (IG Insights shows it) but the "60%+ hold =
  5-10x reach" figure only appears in unsourced SEO posts; do not build targets on it.

**The mechanic we are most likely ignoring: sends/shares.** It is the top-weighted Reels signal per
Mosseri and the one where we are at literally zero across 44 IG posts. Every winning video in §2 with
>100 shares is either a story a viewer would send to a colleague ("solution to active under
contract" 222 shares) or a provocation ("How to become a real estate agent" 215 shares). A demo of a
deadline lookup is not something one agent sends another.

---

## 5. Meta ads at ~$300, Texas agents

Benchmarks (independent datasets only; vendor blogs flagged):

| Metric | Real estate vertical | All-industry | Source |
|---|---|---|---|
| CPC (lead-gen objective) | $1.57 | $1.92 | LocaliQ/WordStream Facebook benchmarks, 2025-10-24 |
| CTR (lead-gen) | 3.75% | 2.59% | same |
| Landing-page CVR (lead-gen) | 9.53% | 7.72% | same |
| CPL | **$16.61** | $27.66 | same |
| CPM | $28.66 median national; ~$5.13 for tight geo-local RE campaigns | $20.58 | Superads/Varos, $3B spend panel, Jul 2025-Jul 2026 |
| B2B SaaS CPC / CTR | $2.00-4.50 / 0.8-1.1% | — | get-ryze.ai, digitalapplied.com 2026 — **vendor/SEO aggregations, directional only** |

**$300 math.** At $28.66 CPM: ~10,470 impressions → at 3.75% CTR ~393 clicks → at 7.7-9.5% CVR
30-37 leads. At the $16.61 vertical CPL, more conservatively **~18 leads; at all-industry CPL ~11**.
Those are email captures, not trials. Applying typical lead→trial attrition, expect **1-5 trial
signups from $300**. Not enough to A/B creative; enough to seed the pixel and a lookalike.

**Targeting:** job-title "real estate agent" is not reliably available; Meta removed detailed-
targeting exclusions in July 2024 and consolidated categories again June 2025 (Social Media Today,
Jon Loomer). Working proxies: interest stacks around real-estate brands, Advantage+ with
Texas-only location control, and a lookalike from the customer/founding-applicant list (thin at ~11
customers + applicants but usable).

**Creative that converts, B2B SaaS to SMB professionals:** consistent agency consensus for founder-
to-camera, phone-shot, UGC-style video over polished demo (AdStellar, adlibrary.com 2025-26) — but
**no independent study with a numeric lift was found**, and no Meta case study exists for any
SaaS selling *to* agents (Follow Up Boss, kvCORE, Sierra, Real Geeks, CINC, Ylopo, Luxury Presence,
Dotloop, SkySlope all publish nothing on their own acquisition CPL). The only controlled evidence is
the Yang 2026 presenter study (§3): human presenter +0.46 purchase intention over caption-only and
AI-avatar conditions.

---

## 6. Founder-on-camera + clipping tool vs the automated pipeline

Prices fetched 2026-09-18.

| Tool | $/mo | Free tier | AI clip selection from a 30-min file | Captions | 9:16 reframe | Direct publish | Human min/week for 15 clips* |
|---|---|---|---|---|---|---|---|
| OpusClip | $0 / $15 Starter / $29 Pro | yes, watermarked, spoken-word clipping only | yes (Starter+); ClipAnything on Pro | auto, ~95-98% on clean audio | yes | Starter+ post, Pro schedules | 60-90 |
| Descript | $0 / $16 Hobbyist / $24 Creator | 60 min/mo, 720p, watermark | Underlord (Creator) | yes | yes | no scheduler | 90-120 |
| CapCut | $0 / ~$9.99 web / $19.99 app-store Pro | mostly unwatermarked; free web "AI Clip Generator" | yes, free | yes, multi-language | yes | no | 75-100 |
| Sora / Sora 2 | n/a | n/a | **no** — generative only; consumer app shut 2026-04-26, API retires 2026-09-24 | — | — | — | n/a |
| Vizard | $0 / $14.50-29 | 60 min, watermark, 10-min exports | yes | yes | yes | Creator+ | 70-100 |
| Klap | $14-63 | 1 clip total | yes | yes | yes | some | 70-100 |
| Submagic Starter (we pay $12) | $12 | — | **no** — "Magic Clips" is a separate paid add-on capped at 10 source videos/mo; Starter = 15 videos/mo, 2-min max | yes | limited | 1 profile/platform | not viable as primary: 15/mo vs 60+/mo needed |
| Instagram Edits (Meta, Apr 2025) | $0 | unlimited, no watermark | no (manual trim) | styled auto-captions, eye-contact fix, teleprompter | manual | native to IG/FB | high if used alone |
| YouTube "Edit into a Short" | $0 | unlimited | no | basic | manual | native | high |

*Includes review, caption fixes and posting; excludes the 30-min recording itself.

Independent OpusClip test: ~7/10 agreement with a human editor's clip picks on a clean solo talking
head, ~4/10 with overlapping speakers (SendShort 90-day review). Clean solo phone recordings are the
best case for every tool here.

**Pick for a founder with 30 min/day and $0:** record on the phone (vertical, native, Edits'
teleprompter if needed) → **CapCut free web AI Clip Generator** to cut 15-20 candidates and reframe
→ **Instagram Edits** for captions, eye-contact fix and direct publish to IG/FB → re-upload the same
MP4 to TikTok and Shorts. Keep Submagic Starter for the 2-3 flagship clips a week where its caption
polish is worth the capped allowance. Skip Sora (wrong tool and dead in six days), skip paid tiers
until a format proves out. One caveat: CapCut's June 2025 ToS grants a perpetual licence over
uploaded face/voice content (2b-advice, Yahoo Tech); if that is unacceptable, Descript Hobbyist at
$16 is the cleanest paid alternative. CapCut's free tool's exact monthly clip cap was not stated on
its page — confirm in-app before committing the weekly load.

Cost of the automated pipeline for comparison: it is already paid for (Creatomate/Pexels/ElevenLabs/
HCTI) and it produced a median of 2 views per Instagram post. The marginal cost of the human pipeline
is 30 min/day of Heath plus ~90 min/week of clip review, and the benchmark evidence says that is the
only input that has ever produced six-figure views in this niche.

---

## Verified vs. not

- **Verified live (2026-09-18):** all TikTok follower/like/video counts and per-video play/share/
  comment/duration figures; all YouTube subscriber/view/video counts and Shorts first-page view
  counts; our Supabase analytics and cadence; cover-frame inspection for Tat (x2), Glennda (x2), Dan
  Martell, Coach Milan J, The Broke Agent; our own cover and demo frames.
- **Secondhand, dated:** Instagram follower counts (Broke Agent ~330-350k, Coffee & Contracts 129k);
  Cal AI, Stronger and Natural Write case-study numbers; Glennda's daily cadence and GCI (NAR/
  HomeLight interviews, 2021-22).
- **Not found / do not exist:** a controlled face-vs-faceless dataset from a major platform-analytics
  vendor; any Meta case study for SaaS sold to real-estate agents; a numeric founder-vs-demo ad lift;
  TikTok Creator Academy's exact cadence text; Mosseri's verbatim "sends" wording.

---

## Sources

Accounts and videos (all read 2026-09-18 via curl of the public page JSON):
- https://www.tiktok.com/@tatlondono · videos /7541891906347732231, /7488848295134072069, /7475506730659630341
- https://www.tiktok.com/@glenndabaker · videos /7287958256650112302, /7644165033403911454, /7273545384352435498, /7486083066625019167, /7497992257178471710, /7562924418062765342
- https://www.tiktok.com/@thebrokeagent · video /7294346607498186026
- https://www.tiktok.com/@danvmartell · videos /7563122551203974416, /7625753930458303752, /7511851584913952056, /7491722468143435013
- https://www.tiktok.com/@milan_tccoach/video/7214992921454546219 · https://www.tiktok.com/@lexi.barraza · https://www.tiktok.com/@zachyadegari · https://www.tiktok.com/@meetdossietc
- https://www.youtube.com/@BrandonMulrenin/shorts · @LoidaVelasquez · @KyleHandy · @TomFerry · @CoffeeContracts · @danmartell

Interviews / case studies:
- NAR Magazine, "How This Agent Is Making Six Figures on TikTok" (Glennda Baker) — https://www.nar.realtor/magazine/real-estate-news/technology/how-this-agent-is-making-six-figures-on-tiktok
- HomeLight, Glennda Baker 8 deals / $141k GCI — https://www.homelight.com/blog/agent-glennda-baker-tik-tok-real-estate-podcast/
- Inman, 2025-08-15, Tat Londono (403 on fetch; follower count corroborated by TikTok JSON) — https://www.inman.com/2025/08/15/hgtv-who-tiktok-not-reality-tv-took-this-brokers-business-to-another-level/
- Luxury Presence, TikTok for RE agents guide (account list with followers) — https://www.luxurypresence.com/blogs/the-complete-guide-to-tiktok-for-real-estate-agents/
- Tom Ferry, "How to Use TikTok for Real Estate in 2026" — https://www.tomferry.com/blog/tiktok-for-real-estate/
- AgentFire, best RE YouTubers 2025 — https://agentfire.com/blog/best-real-estate-youtubers-2025/
- Coffee & Contracts about page — https://coffeecontracts.com/about
- Postiz, Natural Write 90-day TikTok case — https://postiz.com/blog/tiktok-marketing-strategy-100k-90-days
- CNBC 2025-09-06, Cal AI — https://www.cnbc.com/2025/09/06/cal-ai-how-a-teenage-ceo-built-a-fast-growing-calorie-tracking-app.html
- Better Launch, Blake Anderson 13 tactics — https://www.betterlaunch.co/playbooks/episodes/blake-3apps
- getlatka, Cal AI revenue — https://getlatka.com/companies/calai.app
- Superwall, Stronger "viral on demand" — https://superwall.com/blog/how-stronger-built-a-usd600k-app-using-viral-on-demand-tiktok-strategy
- videohighlight summary of Dan Martell "1M followers in 12 months" — https://videohighlight.com/v/fuLxzFE72tw

Face / synthetic presenter research:
- Yang, "Human Presence in Short-Form Video Advertising: Social Judgments of Human and AI Presenters," Behavioral Sciences 2026 — https://pmc.ncbi.nlm.nih.gov/articles/PMC12938081/
- "The impact of face presence in user-generated videos on consumer engagement," IJRM 2025 — https://www.sciencedirect.com/science/article/abs/pii/S0167811625000096
- thecontentlabs.app 7,431-video study — https://thecontentlabs.app/blog/faceless-vs-face-on-camera-data-study

Platform mechanics:
- Instagram, "Instagram Ranking Explained" — https://about.instagram.com/blog/announcements/instagram-ranking-explained
- Instagram Help, Trial Reels — https://help.instagram.com/835643311711702/
- PetaPixel 2026-04-30 — https://petapixel.com/2026/04/30/new-instagram-policies-target-reposted-content/
- Tubefilter 2026-04-30 — https://www.tubefilter.com/2026/04/30/instagram-removes-algorithm-recommendations-repost-content-aggregator/
- TikTok Newsroom, "How TikTok recommends videos #ForYou" — https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you
- TikTok Newsroom, AI labels — https://newsroom.tiktok.com/en-us/new-labels-for-disclosing-ai-generated-content
- Buffer, TikTok posting frequency (11.4M posts), 2025-10-08 — https://buffer.com/resources/how-often-should-you-post-on-tiktok/
- Social Insider Instagram benchmarks 2026 — https://www.socialinsider.io/social-media-benchmarks/instagram
- Social Insider TikTok benchmarks 2026 — https://www.socialinsider.io/social-media-benchmarks/tiktok
- Sprout Social Support, Shorts view-count change — https://support.sproutsocial.com/hc/en-us/articles/35874991211533
- Search Engine Journal, YouTube inauthentic-content update — https://www.searchenginejournal.com/youtube-targets-mass-produced-content-in-monetization-update/550337/
- air.io, Shorts vs long-form (18,000 channels) — https://air.io/en/audience-growth/do-youtube-shorts-help-your-long-form-videos-grow-data-from-18000-channels

Ads:
- LocaliQ Facebook benchmarks 2025 — https://localiq.com/blog/facebook-advertising-benchmarks/
- WordStream Facebook benchmarks 2025 — https://www.wordstream.com/blog/facebook-ads-benchmarks-2025
- Superads/Varos real-estate CPM — https://www.superads.ai/facebook-ads-costs/cpm-cost-per-mille/real-estate
- Social Media Today, detailed-targeting exclusions removed — https://www.socialmediatoday.com/news/meta-removes-detailed-targeting-exclusions-from-ad-campaigns/723389/
- Jon Loomer — https://www.jonloomer.com/qvt/detailed-targeting-exclusions/
- AdStellar founder-led ads (agency opinion) — https://www.adstellar.ai/blog/founder-led-ads
- adlibrary.com Meta ads for B2B SaaS (agency opinion) — https://adlibrary.com/posts/meta-ads-for-b2b-saas
- get-ryze.ai / digitalapplied.com 2026 benchmarks (vendor aggregations) — https://www.get-ryze.ai/blog/meta-ads-cost-benchmarks-by-industry-2026 · https://www.digitalapplied.com/blog/facebook-ads-benchmarks-2026-cpc-cpm-ctr-industry

Tools:
- OpusClip pricing — https://www.opus.pro/pricing · SendShort review — https://sendshort.ai/guides/opus-review/
- Descript pricing — https://www.descript.com/pricing · review — https://videoshufflr.com/blog/posts/descript-ai-video-editor-review-2026.html
- CapCut AI clip maker — https://www.capcut.com/tools/ai-clip-maker · pricing — https://bigvu.tv/blog/capcut-free-vs-pro-what-2026s-restructure-actually-gives-you/ · ToS — https://2b-advice.com/en/2025/07/04/capcut-trouble-over-new-terms-of-service-legal-risks-lurk-here/
- OpenAI Sora discontinuation — https://help.openai.com/en/articles/20001152-what-to-know-about-the-sora-discontinuation
- Submagic Magic Clips — https://www.submagic.co/features/magic-clips · Vizard pricing — https://www.ezugc.ai/vizard-pricing · Klap — https://ampifire.com/blog/klap-reviews-pricing-is-this-the-best-ai-app-to-turn-long-form-videos-into-short-clips/
- Instagram Edits — https://www.inro.social/blog/edits-new-meta-app
