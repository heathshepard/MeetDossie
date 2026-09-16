# Scroll-Stopping Video Playbook

Owner: Sage. Applies to every short-form video across Rust, Dossie, and realtor content —
FB/IG/TikTok/YouTube Shorts/X. Written 2026-09-15 after Heath's "go back to school" note:
current Rust videos have no hook, no cover, and zero scroll-stopping power.

**The one-line verdict up front:** the 9 Rust `Media/rust-conversations/*.mp4` files are not
underperforming hooks — they are a static black-background text-card slideshow with **no motion,
no app footage, no face, and identical frame-1/frame-1.5s content** (verified by pulling frames,
not guessing). There is nothing for a hook formula to attach to. Fix the format first, then apply
everything below.

---

## 1. Research — what actually moves the needle (2025-2026 sources)

### 1.1 The first 1-3 seconds

- **Retention drops hardest in the first 3 seconds and that window now gates distribution.**
  Second-by-second curves show 100%→75-85% in second 0-1, then to 50-60% by second 3; a hook that
  holds 55%+ at second 3 is "strong" by top-performer standards. TikTok's 2025-2026 algorithm
  reporting puts the completion-rate bar for broad distribution at roughly 70%, up from ~50% a
  couple years ago — and that number cascades entirely from what happens in the first 3 seconds.
  [TikTok 3-Second Rule (2026), Teleprompter.com](https://www.teleprompter.com/blog/tiktok-3-second-rule)
- **Instagram's Hook Rate is now a named, measured metric** (3-second views ÷ impressions).
  Guidance: aim above 30%, treat below 25% as a real opening problem regardless of the rest of the
  video. For organic Reels the 2026 threshold below which reach gets capped is ~50%; accounts
  under 25K followers should target 40%+.
  [Hook Rate, Hold Rate, Completion Rate — CreatorHouse (2026)](https://creatorhouse.app/blog/instagram-reel-hook-rate-hold-rate-completion-rate-benchmarks)
- **Instagram's algorithm now weighs engagement in the first 0.5 seconds — before audio even
  starts** — which is why the opening *visual* frame (not just the opening line) has to do work on
  its own, sound-off.
  [Instagram Reels Reach 2026 — TrueFuture Media](https://www.truefuturemedia.com/articles/instagram-reels-reach-2026-business-growth-guide)
- **Layered hooks measurably beat single-technique hooks.** Reported blueprint: 0-1s visual
  interrupt (zoom/motion), 1-2s auditory hook + text overlay, 2-3s verbal promise that resolves the
  visual tease. Single-technique hooks cap near 60% retention; layered hooks reported near 90%.
  [17 Hook Formulas for Short Video Retention — Faceless.so](https://faceless.so/blog/17-hook-formulas-for-short-video-retention)
- **Text overlay is not optional — 60%+ of mobile viewers watch sound-off.** Best-practice spec:
  bold, high-contrast, 5-8 words, on screen 2+ seconds, reinforcing (not just repeating) the spoken
  line.
  [Short-Form Video Hooks — Terra Market Group](https://www.terramarketgroup.com/digital-marketing-2/short-form-video-hooks-7-formulas-for-70-retention/)
- **Misleading hooks are now actively punished, not just ignored.** TikTok tracks "early exit
  rate" as a negative ranking signal; 58% of surveyed users say they've unfollowed an account over
  a misleading hook. Trending hook formats also cycle fast — average lifespan dropped from 8 weeks
  (2023) to 3.5 weeks (2025), so a hook has to be genuinely true and specific to the product, not a
  borrowed trend line.
  [Short-Form Video Hooks — Terra Market Group](https://www.terramarketgroup.com/digital-marketing-2/short-form-video-hooks-7-formulas-for-70-retention/)

**Takeaway for Rust/Dossie/realtor:** the opening frame needs (a) real motion or a visual pattern
interrupt within the first second, (b) on-screen text that makes a specific, true, swap-test-proof
claim (see `marketing/rust-hook-library.md` principles — already correct, just never gets
rendered against real footage), and (c) a spoken line that pays off the visual within 2-3 seconds.
A static slide, however well-written, only ever clears layer 2 of 3.

### 1.2 Covers / thumbnails per platform

- **IG Reels cover:** 1080×1920 canvas, but only the **center ~1080×1350 px block survives every
  crop** the cover gets shown in (9:16 in Reels tab, 4:5 in main feed, 3:4 on profile grid). Keep
  text/face dead-center, 3-5 words max.
  [Instagram Reel Cover Size 2026 — JW Toolbox](https://www.jwtoolbox.com/blog/instagram-reel-cover-size-cheat-sheet-2026)
  [socialk.it Reel Size 2026](https://socialk.it/en/sizes/instagram-reel-size)
- **TikTok cover:** same 1080×1920 canvas. TikTok's own UI reserves the **top ~130-200px** (tabs/
  search) and **bottom ~334-484px** (caption, hashtags, audio marquee, and — on ads — the CTA
  button) as danger zones; right edge needs ~140px clear for the like/comment/share stack, left
  edge ~44px for crop safety. Put cover text in the vertical band roughly 20%-65% of frame height.
  [TikTok Safe Area Overlay Guide 2026 — CheckSafe.Zone](https://checksafe.zone/articles/tiktok-safe-area-overlay-guide-2026)
  [TikTok Safe Zone Guide 2026 — EzUGC](https://www.ezugc.ai/blog/tiktok-safe-zones-guide)
- **YouTube Shorts:** the cover you pick barely matters *inside* the Shorts feed (autoplay, no
  thumbnail shown) but drives tap-through from your channel page, search, and suggestions. Choose
  a visually distinct frame from the actual footage; avoid dense text since the vertical frame may
  get auto-cropped to 4:5 on some surfaces — keep the key element centered.
  [YouTube Shorts Thumbnail Best Practices 2026 — ContHunt](https://conthunt.app/blog/youtube-shorts-thumbnail-best-practices-2026)
- **FB Reels:** inherits the same Meta cover mechanism as IG (Meta unified the stack) — same
  1080×1920 canvas, same center-safe-zone logic applies.
- **X (video post):** no separate "cover" upload UI for native video the way IG/TikTok have it —
  X uses the first meaningful frame or an attached still. Practical fix: make **frame 1 of the
  actual export** the cover-quality frame (bold text card or a genuinely striking visual), since
  there's no second chance to set one after upload.

**What the cover should carry, every platform:** the specific claim from the hook (not the brand
name, not a logo-only card), 3-5 words, high contrast, centered. "HEATH — BUILT THIS" (the current
Rust label) is a byline, not a hook — it says nothing about the video itself.

### 1.3 "Screen recording of a chat with an AI" — how this sub-genre is actually made

- **Auto-zoom on the point of interest is now table-stakes**, not a manual after-effect. Modern
  screen-recording tools detect cursor movement / text entry and punch in so the viewer can
  actually read what's happening — critical for an app demo where the payoff is a UI element
  changing.
  [Screenify Studio — Screen Record for TikTok & Reels (2026)](https://www.screenify.studio/blog/2026-04-10-screen-record-for-tiktok)
- **Word-level animated captions inside the title-safe zone are the baseline, not a nice-to-have**,
  because the majority of viewers are sound-off. 3-5 words on screen at a time, timed to speech
  rhythm.
  [Screenify Studio — Screen Record for TikTok & Reels (2026)](https://www.screenify.studio/blog/2026-04-10-screen-record-for-tiktok)
  [Virlo — TikTok Video Editing Tips](https://virlo.ai/blog/tiktok-video-editing-tips)
- **The real "talking to AI" viral format is literally a phone screen recording of the actual
  chat UI**, with the reveal as the payoff, edited afterward with captions/effects — not a
  narrated summary of what the AI said. The visual proof of the real interface reading real
  input is the format; a stylized recreation is a weaker substitute.
  [Forbes — TikTok skits reveal ChatGPT is confidently wrong (2026)](https://www.forbes.com/sites/danidiplacido/2026/04/15/tiktok-is-exposing-the-fatal-flaw-of-generative-ai/)
- **Pacing:** cuts/zooms/caption pops land on beat with the audio (voice cadence if no music);
  avoid dead air — every 2-3s should have a visual event (a new message appearing, a punch-in, a
  caption change, a UI element updating).
  [Virlo — TikTok Video Editing Tips](https://virlo.ai/blog/tiktok-video-editing-tips)

**Applied to Rust:** the coach's real reply appearing character-by-character or bubble-by-bubble
in `CoachChat.tsx`, the `ReadinessCheck.tsx` sliders actually moving under a real thumb-drag, and
a real number changing on screen (working weight, a set count) *is* the hook material. None of
that exists in the current renders because the pipeline never opens the app.

### 1.4 Fitness-app / AI-coach content: what works vs. what flops

- **What works:** creator-coach trust content (a real person's face vouching, not a faceless
  narrator), humor that makes the category approachable, and — most relevant here — **visible
  before/after proof inside the app UI** (a number that changed, a plan that adapted) rather than
  generic transformation photography.
  [TikTok "AI Fitness App Review" discovery hub](https://www.tiktok.com/discover/ai-fitness-app-review)
- **What flops (by omission — the successful examples above all share what the Rust videos lack):**
  faceless narration over a static or generic background, claims with no visible proof in the app
  itself, and generic "AI fitness coach" language that doesn't differentiate from the dozen
  identically-pitched apps in the same discovery feed (Zing AI, F/AI, SmartLife AI, FitnessAI all
  use near-identical copy — "scan your body," "personalized workout in seconds"). A video that
  could describe any of those apps equally well is the "swap test" failure the hook library
  already names, now confirmed as the actual competitive field.
  [TikTok fitness-app discovery hub search, aggregated Sep 2026]

### 1.5 Length / loop

- **TikTok's own 2024-2025 creator-fund data: 21-34 seconds had the highest completion rate.**
  Over 60s can drive reach but works against completion.
  [ScrollScript — How Long Should a TikTok/Reel/Short Be](https://scrollscript.ai/blog/how-long-should-a-tiktok-reel-youtube-short-be)
- **Instagram loops aggressively — a 7s video watched 3x counts as 300% retention**, which the
  algorithm reads as a strong signal. Reported sweet spots: 7-15s for viral reach, 30-45s for
  "value" content meant to convert rather than spread.
  [ScrollScript — How Long Should a TikTok/Reel/Short Be](https://scrollscript.ai/blog/how-long-should-a-tiktok-reel-youtube-short-be)
- **Completion rate beats absolute length every time**: an 80%-retained 30s video outperforms a
  40%-retained 10s video, and a 20s video holding 80% beats a 60s video that loses half its
  viewers by second 12.
  [CreatorHouse — Hook Rate / Hold Rate / Completion Rate benchmarks (2026)](https://creatorhouse.app/blog/instagram-reel-hook-rate-hold-rate-completion-rate-benchmarks)

**Applied here:** the 3 Rust conversation videos run 35.9s-42.6s — past the 21-34s completion
sweet spot and nowhere near IG's 7-15s loop zone, on top of having no motion to hold attention
through that runtime. Length is fixable, but it's the third problem, not the first.

---

## 2. Hook formula bank (20+, Rust-first with Dossie/realtor variants)

Every hook below passes the swap test from `marketing/rust-hook-library.md` (§Hook principles) —
name a specific, true, product-only fact, not a category claim. Format for each: **on-screen
text (frame 1)** / spoken line it sets up / platform fit.

**Verified-fact guardrails carried over from the hook library and the audit in
`docs/RUST-PRELAUNCH-MARKETING-PLAN.md`:** readiness sliders are **1-5, not 1-10**; there is
**no calendar-based deload** (only per-exercise 10% back-off after missed reps); price is
**$19.99**; coach is subscription-gated; iOS is App Store review / Android closed testing —
never claim "live in the store." Never invent user counts or testimonials.

### Rust — founder / solo-build

1. **"One guy. 121 pieces of equipment. Zero funding."** → sets up the equipment catalog reveal on
   screen. TikTok cover, IG Reel.
2. **"I'm the only employee. Watch me find my own bug."** → cold open on a real error state or
   edge case caught live in the chat. TikTok/FB caption opener.
3. **"This app has one investor. Me."** → cuts to a real screen recording of the sign-in/build.
   IG Reel cover.
4. **"I built the coach that would've told me the truth four years ago."** → founder-story framing,
   pairs with Val (military-instructor coach) without naming service history as a credential —
   see `conv-founder-val.json` notes. TikTok text overlay.

### Rust — problem / agitation (proof must appear on screen within 3s)

5. **"Told it I slept a 2 out of 5. Watch what happens to the weight."** → real slider drag +
   real coach reply. This is the corrected, code-verified version of hook #11/#35 flagged in the
   audit. IG Reel cover, TikTok overlay.
6. **"Hit your reps, it adds 5 lbs. Miss them badly, it takes 10% off. That's the whole
   algorithm."** → screen recording of an actual set log + the number changing. TikTok cover.
7. **"Every app I paid for gave me the same plan on my best day and my worst day. This one
   didn't."** → cuts directly into the 3-slider readiness check, not a text card. IG/FB.
8. **"You said your shoulder hurts. Watch it swap the exercise before you finish typing."** →
   real `CoachChat.tsx` swap in progress. TikTok, strongest pattern-interrupt of the set.

### Rust — curiosity / pattern-interrupt

9. **"I asked my own AI coach the dumbest question I could think of."** → real chat screen
   recording, punch in on the reply as it streams in. TikTok.
10. **"Six coaches, six real voices. This one doesn't let you off easy."** → voice-selector screen
    + one real spoken line from that coach's actual ElevenLabs voice. IG Reel.
11. **"Watch the number change before I even finish the sentence."** → mid-set weight adjustment,
    zoom-punch on the number. TikTok.
12. **"This is what 'AI fitness coach' actually looks like when it's not just a chatbot bolted
    onto a template."** → split-screen or quick-cut: generic competitor screenshot (publicly
    available marketing image only, not a fabricated mockup) vs. real Rust chat rewriting a set.
    IG/TikTok.

### Rust — coach-persona (single speaker, uses real in-app voice)

13. **"Val doesn't do sympathy. Val does math."** → coach intro over real voice-selector card,
    not a plain color card. TikTok cover.
14. **"I told Marcus I skipped leg day. He noticed before I said why."** → real chat bubble
    reveal. IG Reel.

### Dossie variant — same formulas, TC/agent angle

15. **"Every TC software I tried made me re-type the same deadline three times. This one doesn't."**
    → real dashboard screen recording, a deadline auto-populating. IG/FB, agent audience.
16. **"I asked Dossie what happens if the option period ends on a Saturday. Watch the answer."** →
    real chat screen recording (Dossie voice), payoff is the correct TREC-specific answer
    appearing on screen. TikTok, realtor audience.
17. **"$400 a file for a TC, or this."** → real product screen, cost comparison card that's the
    one verified market anchor (never invented figures). IG Reel cover.
18. **"She caught the missing signature before I did."** → real document-review screen recording,
    zoom-punch on the flagged field. TikTok.

### Realtor-page variant (Heath's own practice content)

19. **"I've closed enough of these to know the clause everyone skips. Watch."** → screen recording
    of the actual contract field, not a talking-head-only clip. IG/FB.
20. **"This is the exact text I send when an offer comes in low."** → real phone/email screen
    recording (Heath's actual voice profile per `heath-email-voice-profile.md`), not a graphic.
    TikTok/Reels.
21. **"The MLS status changed twice in one day. Here's what that actually means for a buyer."** →
    real MLS screen recording per `sabor-mls-status-codes.md` facts only. IG Reel.

**Rule for all 21:** the on-screen text is the claim; the first visual is the proof starting to
render (a real slider moving, a real chat reply streaming, a real field populating) — never a
static quote card standing in for footage that doesn't exist in the edit yet.

---

## 3. Cover spec (apply per platform, per §1.2)

| Platform | Canvas | Safe text zone | Cover text |
|---|---|---|---|
| IG Reels / FB Reels | 1080×1920 | Center ~1080×1350 block (survives 9:16/4:5/3:4 crops) | 3-5 words, dead-center, high contrast |
| TikTok | 1080×1920 | Avoid top ~200px, bottom ~334-484px, right ~140px, left ~44px | 3-5 words in the 20%-65% vertical band |
| YouTube Shorts | 1080×1920, key element centered | Minimal/no dense text — auto-crop risk to 4:5 | Pick an actual striking frame from the footage over adding a text card |
| X | No separate cover upload for native video | N/A | Make export frame 1 the cover-quality frame directly |

Never use a plain brand-lockup or a "byline" line ("HEATH — BUILT THIS") as the only cover
text — it identifies the poster, not the reason to stop scrolling. Byline can be a small
secondary element; the hook claim gets the primary type.

---

## 4. Edit spec — screen-recording-of-chat videos (Rust coach chat, Dossie chat)

Binding spec for any video whose source is `CoachChat.tsx` / `ReadinessCheck.tsx` (Rust) or the
equivalent Dossie chat surface:

1. **Capture real footage first.** Screen-record the live app (Playwright `recordVideo` context,
   or an iOS/Android native screen recording of the TestFlight/closed-test build) — do not
   generate a synthetic color-card in place of footage. `scripts/generate-conversation-video.js`
   is explicitly documented as a placeholder aesthetic ("closer to a captioned-podcast-clip than a
   talking-head video") — it was never meant to be the final format, and per the code audit it has
   never actually captured the app. Reuse the capture scripts already on disk
   (`.tmp/rust-screenshot.js`, `.tmp/rust-screenshots/capture2-ios.js`) as the starting point per
   Rule 1 — extend them to video capture instead of building a new capture path.
2. **Frame 0-1s: a visual event must already be starting.** A slider mid-drag, a message bubble
   mid-appear, a cursor tapping a real button. Never open on a static, unchanging screen.
3. **Punch-in on the payoff.** When the number/text that proves the hook appears (adjusted weight,
   swapped exercise, coach reply), zoom 10-20% into that element for 0.5-1s. This is the "layer 1
   visual interrupt" from §1.1.
4. **Captions: word-level, animated, inside the safe zone from §1.2, 3-5 words visible at once,
   synced to real speech (Heath's clone / the coach's real ElevenLabs voice), never a separate
   narration track describing what's on screen.**
5. **One visual event minimum every 2-3 seconds** — a cut, a punch-in, a new caption line, a UI
   state change. No more than 3s of an unchanging frame anywhere in the edit.
6. **Face-cam overlay (optional, use when available):** small corner bubble of Heath reacting to
   the coach's reply — adds a real human beat without breaking the screen-recording authenticity;
   skip rather than fake it if no real reaction footage exists.
7. **Length: target 21-34s** (TikTok completion sweet spot) for narrative/proof videos; **7-15s**
   for a single sharp proof-moment clip optimized for IG loop reach. Never exceed 45s.
   for content shot as an explicit "value" piece the audience already opted into (rare for cold
   discovery).
8. **Loop-friendly ending:** last frame/line should connect back to the opening claim ("...and
   that's the whole algorithm" cutting back to the cover text) so a replay reads as intentional,
   not abrupt.
9. **CTA card:** current, correct CTA only — `rustfitness.app · join the waitlist` for Rust
   (never `/founding`, which is Dossie-specific and closed anyway). 2-2.5s hold, brand-correct.

---

## 5. Pre-publish checklist (binary, run on every video before it posts)

**Hook structure — hook-then-clear (hard requirement, added 2026-09-15 after the `readiness-marcus-v2`
test cut):** the hook is a distinct opening beat, not a permanent overlay. It must be full-bleed and
dominate the frame for roughly 1.5-3s to stop the scroll, then get out of the way completely so the
real app footage fills the frame at full size — chat text, UI, numbers all legible without a phone-
bezel mockup shrinking them down. A hook that rides on screen for the whole video (as both
`readiness-marcus-v2-hookA/B` originally did, permanently docked across the top ~40% with a small
phone-mockup inset below it) fails this checklist even if every other item passes, because it never
actually clears and the footage underneath is too small to read.

1. [ ] Frame 1 (0.0s) shows the hook full-bleed with real motion already starting — a punch-in/zoom,
   a sliding color block, or an equivalent visual event, not a static unchanging card. (Motion must
   be present at frame 0, not just at the moment the hook clears.)
1a. [ ] The opening is NOT a real login/sign-in/sign-up/password/magic-link screen, and is NOT a
   dead frame carrying neither legible text nor product UI (blank, loading spinner, skeleton,
   empty-state placeholder). A designed hook/title card — large legible text on a solid-colour
   background, exactly what item 1 asks for — is a PASS here, not a violation; the rule only exists
   to catch a login screen or a genuinely dead opening (Heath, 2026-09-16, after the gate flagged the
   `readiness-marcus-v3` cut and a Dossie hook-card cut for having a solid-colour opening frame — that
   was the wrong call, narrowed the same day).
2. [ ] The hook fully clears by 3.0s — cut or transition to the real app footage filling the entire
   frame, no residual hook band, headline, or byline still on screen after that point.
3. [ ] On-screen hook text makes one specific, swap-test-proof claim (competitor's name couldn't
   replace the product name and have it still be true) AND grabs visually — a bold color block,
   a circled/highlighted element, or equivalent — not text alone on a flat background.
4. [ ] The claim in the hook is verified against live code/data today, not memory (readiness
   slider range, price, deload behavior, App Store status, etc. — see §2 guardrails).
4a. [ ] **NO CLAIM MAY CONTRADICT A VALUE VISIBLE ON SCREEN AT THAT MOMENT** (Heath, 2026-09-16,
   second time). This covers the hook card, the captions and the voiceover, and it is checked
   frame-by-frame, not in the abstract — a hook reading "SLEPT A 2 OUT OF 5" over a frame where
   the slider still shows the default 3 is a fail even though the take does eventually show a 2.
   Two consequences for the edit:
   - Don't speed-ramp past the moment the number actually changes. The frame at every verification
     timestamp must agree with every claim on screen.
   - **Anything a persona cites must have been shown first.** If the coach says "your lower back's
     sore", the video has to have held the Soreness 3 + "Lower Back" selection on screen — long
     enough to read (~1.5-2s) and BEFORE he says it — or he looks like he's inventing context.
     If the context came from a typed message instead, show the message.
   **Fix this by re-recording or re-cutting so the screen and the claim agree — never by rewriting
   the text over a take that says something else.**
5. [ ] A visual event (cut/punch-in/caption change/UI update) occurs at least once every 2-3
   seconds throughout — including inside the hook itself, not just in the footage after it.
6. [ ] Captions are burned in for the FULL runtime with no gaps — phrase-level or word-level,
   bottom-third, inside the platform safe zone, high-contrast (opaque box or heavy outline) so
   they're legible with sound off regardless of what's behind them. During the hook, the hook's
   own on-screen headline satisfies this; during footage, every line of real dialogue on screen
   gets a synced caption card. Caption text must be verbatim what the app actually displayed —
   never a paraphrase or an invented line, and never words put in the coach's mouth. If a
   voiceover is added later, captions must match that audio exactly.
   **Caption typeface is a HEAVY SANS — never a serif** (Heath, 2026-09-16). Repo default is
   `public/fonts/PlusJakartaSans-Bold.ttf`, white on an opaque dark box, ~64px on a 1080×1920
   canvas. Cormorant Garamond is a Dossie *brand/heading* face and is never a caption face.
   **A caption box must never land on top of chat/message text.** The fix is NOT to shrink the
   footage (item 9 forbids that) and NOT to move the caption into the reserved bottom zone — it is
   to slide the crop window DOWN over the capture. A chat thread is top-anchored, so a larger
   `crop_y` lifts the newest bubble clear of the caption band and simply reads as ordinary scroll.
   `scripts/build-rust-shortform-video.py` exposes this as the per-segment `crop_y` knob. Verify by
   diffing the captioned render against the silent master to isolate the caption's bounding box,
   then measuring how much app text sits underneath it — the answer has to be 0%.

6a. [ ] **AUDIO IS MANDATORY. A silent cut fails this checklist outright** (Heath, 2026-09-15/16:
   "it must be the actual conversation, heard, not narration over silence"). Three binary parts:
   - **Heath's lines** use his locked clone `i41TA0Q36AUrp4axERi3`, `eleven_v3`, stability 0.3,
     style 0.4, speaker_boost on, speed inside 0.9-1.15x. Never re-tune
     (`heath-voice-clone-settings-locked.md`). Approved scopes: his realtor listings, Rust,
     and Dossie founder/instructional content — never Dossie's own character voice.
   - **A product persona's lines use THAT persona's real in-app voice**, not a stand-in. For Rust
     coaches the source of truth is `Rust/api/tts.ts` `VOICE_MAP`, mirrored in
     `scripts/voice-select.js` `RUST_COACH_VOICES` (Marcus = ElevenLabs "Brian"
     `nPczCjzI2devNBz1zQrb`, `eleven_multilingual_v2`, stability 0.70 / similarity 0.80 /
     style 0.15 / speaker_boost on). Capturing the app's own "Listen" playback is better still.
     **If the real voice can't be reproduced, ship silent and say so — never substitute a random
     voice for a named persona.**
   - **A persona's spoken words are verbatim what the app actually rendered.** Cutting whole
     trailing sentences to fit runtime is allowed; rewording, re-ordering or paraphrasing is not.
     Each line lands as its bubble appears — retime the VIDEO to the narration, never stretch the
     audio to the video.
6b. [ ] **Music bed present, 18-22 dB under the voice, and licence-clean.** Check what we already
   hold rights to first — `Media/Music/` (Pixabay Content License, commercial use, no attribution;
   see `Media/Music/LICENSE.md`). ElevenLabs music generation is NOT available on our key (the
   Creator plan key returns `missing_permissions: music_generation`, verified 2026-09-16) and
   Pixabay's CDN 403s non-browser downloads. **If no genuinely clean track can be sourced, ship
   without music and say so — never risk a platform copyright claim.** Implementation: normalise
   voice to I=-15 LUFS and the bed to I=-35 LUFS.
6c. [ ] **Voices verified audible over the bed**, not assumed. Run the finished mix back through
   speech-to-text (ElevenLabs `scribe_v1`) and confirm the transcript returns the script verbatim.
7. [ ] Cover image/frame carries the hook claim (3-5 words, centered per §3) — not just a
   brand byline.
8. [ ] Runtime fits the platform target: 21-34s (TikTok narrative) or 7-15s (IG loop clip); never
   over 45s without a specific reach-over-retention reason.
9. [ ] Footage is real captured app/screen footage, not a synthetic slide standing in for it, and
   fills the frame full-bleed after the hook clears — no phone-bezel mockup shrinking it down.
10. [ ] Ending connects back to the opening hook (loop-friendly), and **a CTA end card is present**
    — binary, not optional (Heath, 2026-09-16). 2-2.5s hold, brand-correct, current correct
    URL/offer. Rust = `rustfitness.app` / `join the waitlist`. **Never "download now" / "get it on
    the App Store" while the stores aren't live** — iOS is in review and Android is in closed
    testing (`rust-app-store-submission-state.md`); the honest line is "Not in the app stores yet."
    Dossie's `/founding` is closed and is never the CTA.
11. [ ] Nothing on screen contradicts `docs/CONTENT-DO-NOT-WRITE-LIST.md` or the verified-facts
    guardrails in `marketing/rust-hook-library.md`.
12. [ ] Watched once, sound off, on an actual phone-sized preview — not judged from the editor
    timeline.
13. [ ] Heath approval where the format's own notes require it (e.g. `conv-founder-val.json`
    is explicitly flagged "HEATH MUST APPROVE THIS SCRIPT BEFORE IT RENDERS OR POSTS").

---

## 5a. Engine spec — machine-checkable gate for the posting pipeline

Carter is wiring this into the posting pipeline as an automated gate before a video can be queued.
These are the rules a validator can check without human judgment — the checklist above is the full
editorial bar; this subset is what code can actually verify. A video fails the gate if any check
fails, no exceptions.

| # | Check | Method | Pass condition |
|---|-------|--------|-----------------|
| 1 | Hook present at frame 0 | Decode frame at t=0.0s | Frame is not empty/black-only and differs from a blank canvas (non-trivial pixel variance) |
| 2 | Hook cleared by 3s | Decode frame at t=3.0s; diff against frame at t=0.0s and against a mid-footage frame (e.g. t=8s) | Frame at t=3.0s has >90% pixel-region similarity to mid-footage composition (i.e., no hook band/overlay still occupying the frame) |
| 3 | Captions present for full runtime | Parse burned subtitle track (or ASS/SRT source used to burn) | Cue coverage spans `[0, runtime]` with no gap longer than 0.3s |
| 4 | Cover set | Check for a dedicated cover asset (`cover-*.png` or platform cover field) | Non-null, same aspect ratio as video, resolution ≥1080×1920 |
| 5 | Runtime in range | `ffprobe` duration | TikTok: 21-34s. IG loop: 7-15s. Reject outside range without an explicit override flag. |
| 6 | Safe zones respected | Check caption/text bounding boxes against platform reserved zones (top ~130-200px, bottom ~334-484px, right ~140px, left ~44px per §1.2) | No caption or hook text bounding box intersects a reserved zone |
| 7 | Resolution/aspect | `ffprobe` stream dims | 1080×1920 (9:16), `yuv420p` or equivalent broadly-compatible pixel format |
| 8 | **Audio track exists and is not silence** | `ffprobe` streams + `astats` RMS over the voice windows | An `aac`/`mp3` audio stream is present, duration within 0.1s of the video, and RMS over each declared voiceover window is ≥ -24 dBFS. A silent or missing track is an automatic FAIL (§5 item 6a). |
| 9 | **Music bed present and correctly ducked** | Loudness of the voice stem vs the music stem before the final mix (`loudnorm` targets recorded in the build spec) | Voice I=-15 LUFS, bed I=-35 LUFS → bed 18-22 LU under the voice. Bed absent is a FAIL unless the build spec carries an explicit `"music": null` + a written reason (no licence-clean source available). |
| 10 | **Voices intelligible over the bed** | Speech-to-text the FINAL mixed audio (ElevenLabs `scribe_v1`) and diff against the voiceover script | Transcript matches the script word-for-word (allowing punctuation/contraction drift). Anything less means the bed is too hot or the VO too quiet. |
| 11 | **Captions match the spoken audio exactly** | Diff each caption cue's text against the text sent to the TTS engine | Concatenated cue text == TTS input text, character for character. Enforced in code by `scripts/build-rust-shortform-video.py` (`phrase_cues` raises on mismatch). |
| 12 | **Caption typeface is a heavy sans** | Read the burned subtitle source's `Fontname` / the font file used | Font family resolves to a sans-serif at weight ≥700 (repo default: Plus Jakarta Sans Bold). A serif family (e.g. Cormorant Garamond) is an automatic FAIL. |
| 13 | **No claim contradicts a visible value** | Decode a frame at each claim's on-screen moment; assert the value the claim names is the value rendered | Hook/caption/VO claim == on-screen value at that timestamp. Anything a persona cites must have been shown, readably, before they say it (§5 item 4a). |
| 14 | **No caption lands on app text** | Diff the captioned render against the silent master to isolate each caption's bounding box, then measure app-content brightness underneath it in the silent master | 0% of the caption box overlaps rendered message text. Fix with the segment's `crop_y`, never by shrinking the footage. |
| 15 | **Loop closes** | Diff frame 0 against the final frame | <2% of pixels differ — the last frames return to the opening composition so a replay reads as intentional (§5 item 10). |
| 16 | **CTA end card present** | Decode the final 1.0s; OCR or match against the known CTA card asset | The last ≥2.0s is a CTA card carrying the current correct URL/offer, and contains no app-store download claim while the stores are not live. |
| 17 | **Opening is not a login screen or a dead frame** (`opening_not_login_or_empty`) | Vision-check frames at t=0.0s and t=1.5s together (Anthropic vision call, same transport as checks 1/2) | FAIL only if either frame is a real login/sign-in/sign-up/password/magic-link screen (even with credentials pre-filled), OR a frame with neither legible text nor visible product UI (blank, loading spinner, skeleton, empty-state). A designed hook/title card — large legible text on a solid-colour background — is a PASS, not a violation of this check; that's what check 1 exists to require. Narrowed 2026-09-16 after the gate wrongly flagged the `readiness-marcus-v3` cut and a Dossie hook-card cut for exactly that reason. |

Checks 1-2 are the automatable proxy for "hook-then-clear": they don't judge whether the hook is
*good*, only that something occupies frame 0 and that it's gone by 3s. Checks 3, 6, 11, 12 and 14 are
the automatable proxy for caption compliance; 8-10 for the audio requirement in §5 item 6a/6b/6c;
13 for §5 item 4a; 15-16 for §5 item 10; 17 for §5 item 1a. Editorial judgment (is the claim true, is the visual grab actually compelling,
does the ending loop back) stays a human/Sage review step — the engine spec does not replace §5,
it's the floor beneath it.

**Reference implementation:** `scripts/build-rust-shortform-video.py` composes a video that passes
1-16 from a JSON build spec (captured frame list + per-segment source→output time mapping, geometry,
punch-in, voiceover clips with their ElevenLabs character-timing JSON, and the music bed). The spec
for a passing build is archived next to its output, e.g.
`Media/rust-videos-v2/2026-09-16/build-spec.json`.

---

## 6. Diagnosis: why the 9 Rust videos fail

Verified by pulling frame 0 and frame 1.5s from all 3 conversation videos with `ffmpeg` and
reading the code path that generates all 9 files (`scripts/generate-conversation-video.js`).

- **Frame 0 and frame 1.5s are pixel-identical in every video checked.** There is no motion for a
  hook to interrupt — literally nothing changes on screen for the entire first 1.5+ seconds
  (often the entire multi-second card). This alone fails §1.1's most basic finding: the algorithm
  and the viewer both decide in the first 1-3 seconds, and there is nothing to decide on.
- **The format is a slideshow, not a screen recording, and was never meant to be final.** The
  script's own header comment calls it a prototype and describes the visual treatment as "closer
  to a captioned-podcast-clip aesthetic than a talking-head video," built specifically because
  there's "no real footage of 'Dossie' to fake." That reasoning is sound for a Dossie
  avatar-video problem — it does not apply to Rust, which has a real, working `CoachChat.tsx` and
  `ReadinessCheck.tsx` UI that was simply never recorded. The workaround for one problem became
  the shipped format for a different problem it wasn't built to solve.
- **No cover strategy at all.** Every video's frame 1 is a full-bleed navy/black card with small
  centered gray text and a tiny gold "HEATH — BUILT THIS" label — a byline, not a hook, and below
  the 3-5 word / high-contrast bar from §1.2 and §3 (the sentences run 12-20+ words).
- **Runtime works against the platform.** 35.9s-42.6s sits above the 21-34s TikTok completion
  sweet spot and far above IG's 7-15s loop zone (§1.5), compounding the no-motion problem — a
  longer static video has more time to lose the viewer, not less.
- **No sound-off redundancy design.** Text cards do carry the words being spoken, but as one
  large centered paragraph rather than 3-5-word animated captions timed to speech — closer to a
  subtitle slide than the caption treatment §1.1 and §1.3 both call the current baseline.
- **Net result:** every video in `Media/rust-conversations/` clears zero of the three layered-hook
  requirements from §1.1 (visual interrupt / auditory hook+text / verbal payoff) because there is
  no visual layer at all — only layer 2 (audio+text) exists, and even that is formatted as a
  paragraph slide, not a caption.

**Fix, in order:** (1) record real app footage per §4.1, (2) apply the hook bank in §2 with real
proof-in-motion instead of a quote, (3) build actual covers per §3, (4) cut to 21-34s, (5) run
the checklist in §5 before anything posts again.

---

## 7. Rebuild plan — the 3 conversation videos

All three currently run as static-card slideshows from
`scripts/conversation-scripts/rust/conv-*.json`. Rebuild uses the same scripts' actual dialogue
(already approved copy, code-verified) but re-shot against real `CoachChat.tsx` /
`ReadinessCheck.tsx` screen recordings instead of color cards.

### 7.1 `founder-val` (source: `conv-founder-val.json`) — target length: 28-32s

**Hook options (on-screen text, frame 1 + cover text):**
1. "Every app gave me the same plan on my best day and my worst day." / cover: **"SAME PLAN. EVERY DAY."**
2. "I asked myself what my app never did. Then I built the question in." / cover: **"IT NEVER ASKED"**
3. "One guy. Three sliders. Zero excuses." / cover: **"ONE GUY BUILT THIS"**

**Shot list (real footage, no text cards standing in for it):**
1. 0.0-1.0s — Open mid-action on the `ReadinessCheck.tsx` sleep slider being dragged to a low
   value by a real thumb (screen recording, punch-in on the slider track). Hook text overlay
   appears at 0.3s.
2. 1.0-6.0s — Heath's cloned voiceover ("Every workout app I paid for...") over the readiness
   check screen with sleep/energy/soreness sliders visible and moving; captions word-level.
3. 6.0-12.0s — Cut to energy + soreness sliders settling; VO continues ("Some days my body is
   just not where it was... The app never once asked" / "So I built the question in").
4. 12.0-14.0s — Screen transition into the coach's response starting to render in `CoachChat.tsx`
   (message bubble appearing) as Val's real ElevenLabs voice begins ("And then somebody actually
   has to do something with the answer...").
5. 14.0-22.0s — Punch-in on the workout screen showing the load actually changing (a rep/weight
   number updating) while Val's VO plays ("You don't get a lighter day because you asked
   nicely...").
6. 22.0-26.0s — Heath VO close ("That's the app. One guy built it. It's not in the stores yet.")
   over a quick screen recording of the sign-in/home screen — real footage, not a card.
7. 26.0-30.0s — CTA card: `rustfitness.app · join the waitlist`, loop-friendly cut back to the
   opening slider-drag frame for the final 1s so a replay reads intentional.

### 7.2 `progression-dev` (source: `conv-progression-dev.json`) — target length: 22-26s

**Hook options:**
1. "Hit your reps, it adds 5 pounds. Miss them badly, it takes 10% off." / cover: **"THE WHOLE ALGORITHM"**
2. "Dev asked how the app picks your weight. Watch the real answer." / cover: **"HOW IT PICKS YOUR WEIGHT"**
3. "No calendar deload. No guessing. Just the math." / cover: **"JUST THE MATH"**

**Shot list:**
1. 0.0-1.0s — Open mid-set-log: a real set being logged in the workout screen, weight field
   already highlighted/updating. Hook text at 0.3s.
2. 1.0-8.0s — VO over real workout-log screen recording as the progression logic actually fires
   (successful set → weight ticks up; a missed-rep set → 10% back-off shown) — this is the one
   real, code-verified mechanic (§2, hook #6) and must be shown literally, not described.
3. 8.0-16.0s — Cut to `CoachChat.tsx` with Dev's persona replying about the plain-language
   explanation, message bubble streaming in real time, punch-in on the reply.
4. 16.0-20.0s — Screen recording of the actual number change (a working-weight figure updating
   after a logged set) — the payoff shot the hook promised.
5. 20.0-24.0s — CTA card, same as above, loop back to the opening set-log frame.

**Guardrail:** do not show or imply a calendar-based deload — the only real mechanic is the
per-set 10% back-off after missed reps (confirmed in `docs/RUST-PRELAUNCH-MARKETING-PLAN.md`).
The script's existing dialogue already avoids this; keep it that way in the visual too.

### 7.3 `readiness-marcus` (source: `conv-readiness-marcus.json`) — target length: 20-24s

**Hook options:**
1. "Three questions before every session. I slept about four hours." / cover: **"BEFORE EVERY SESSION"**
2. "Sleep, energy, soreness. Told the truth. Watch what changed." / cover: **"TOLD THE TRUTH"**
3. "Marcus doesn't punish a bad day. He adjusts for it." / cover: **"HE ADJUSTS FOR IT"**

**Shot list:**
1. 0.0-1.0s — Open on the readiness sliders already mid-drag (sleep slider moving toward a low
   value), real screen recording, punch-in on the slider handle. Hook text at 0.3s.
2. 1.0-7.0s — VO over the three sliders settling (sleep/energy/soreness), captions synced.
3. 7.0-14.0s — Cut to `CoachChat.tsx`, Marcus's real ElevenLabs voice replying, message bubble
   streaming, punch-in on the specific line about adjusting the session.
4. 14.0-19.0s — Screen recording of the actual session plan updating (an exercise swapped or a
   set count reduced) as visible proof of the adjustment — never just Marcus's text claiming it.
5. 19.0-23.0s — CTA card, loop back to the opening slider frame.

**2026-09-15 test cut, superseding the shot list above for this file:** built
`readiness-marcus-v2-hookA/B.mp4` in `Media/rust-videos-v2/2026-09-15/` per hook-then-clear (§5)
instead of the overlay-on-footage-from-frame-0 approach in the shot list above. Structure: 0.0-2.2s
full-bleed animated hook card (punch-in zoom + coral color block behind the emphasis line, per
variant), quick flash-cut transition, then real `raw-readiness-marcus-marcus.mp4` screen recording
full-bleed (cropped to fill 1080x1920, no phone-bezel mockup) from 2.2s to ~31.6s with burned
verbatim captions the entire way (label + phrase-card body, bottom-third, opaque box). The slider
form segment plays at normal speed; the final ~2s beat (Heath's message send + Marcus's second
reply starting to render) is slowed 5x so the caption cards have time to be read without
misrepresenting what the app displayed — a legitimate hold/slow-mo edit, not fabricated dialogue.
Runtime 31.6s (within the 21-34s TikTok band, above this entry's original 20-24s target — the
wider band was used deliberately to fit the full real exchange without cutting off Marcus
mid-sentence). Verified frame-by-frame at 0/1/2/3/5/10/15/20s plus covers before deployment. Known
remaining gaps: no CTA card appended yet (this test cut ends on Marcus's real question, which
works as a loop-friendly/engagement beat but doesn't carry a `rustfitness.app` CTA — add before
this posts for real); no voiceover/audio track (silent per Heath's note that "these clips have no
audio track" — if a VO is added later, captions must be re-synced to match it exactly per §5 item
6).

**2026-09-16 rebuild — `readiness-marcus-v3`, SUPERSEDES the 09-15 test cut.** Output:
`Media/rust-videos-v2/2026-09-16/readiness-marcus-v3.mp4` (33.77s, 1080×1920, yuv420p, AAC 48kHz),
cover `cover-readiness-marcus-v3.png`, build spec `build-spec.json`, voiceover stems under
`voiceover/`. Source footage re-recorded the same day against LIVE
`https://rust-eight-rosy.vercel.app` (the 09-15 footage predated the coach fixes; Marcus no longer
opens with the rest-day line). Capture method: local Playwright, viewport 390×844
`deviceScaleFactor: 3`, **`page.screenshot()` loop at ~14 fps, not `recordVideo`** — `recordVideo`
ignores `deviceScaleFactor` and letterboxes a 390×844 render into the requested canvas; a CDP
`Page.startScreencast` also only ever returns CSS-pixel frames. The screenshot loop is the only
route to true 1170×2532 frames. Three takes were recorded and the strongest exchange kept; the
others were discarded (one had Marcus mis-stating "2 hours of sleep" from a 2/5 slider — a real
model slip, not something to put in an ad). The disposable test account was deleted afterwards via
the app's own `POST /api/delete-account`, and the deletion verified by a failed sign-in.

Structure: 0.00-2.20 hook card (coral emphasis block, continuous punch-in from 1.14×, sub-line pops
at 0.95s) → 2.20-3.70 the three sliders being set → **3.70-5.60 HOLD on the settled answers**
(Sleep 2 / Energy 2 / Soreness 3 / "Lower Back") → 5.60-13.20 Marcus's real opener → 13.20-16.00
Heath typing and sending → 16.00-16.70 thinking beat → 16.70-31.56 Marcus's real reply in two shots
→ 31.56-33.17 CTA card → 33.17-33.77 loop-back to the opening hook frame. Audio: Heath's clone for
his two lines, Marcus's real in-app voice for his two, a Pixabay-licensed bed 20 LU under.
Verified: frames at 0/2.5/4.6/9/20/26/32/33.7s, caption bounding boxes isolated by diffing against
the silent master (all inside y≤1414, x 184-890) with 0.00% app text underneath them,
`ffprobe` streams, `scribe_v1` STT of the FINAL mix returning the script verbatim, and a
first-vs-last frame diff of 0.01% confirming the loop closes.

Three corrections applied on review, all of them things to check on the NEXT build too:
1. **The first cut's hook contradicted the screen.** The readiness beat mapped 5.8s of source into
   3.4s, so the frame at 2.5s still showed the panel's *defaults* (Sleep 3 / Energy 3 / Soreness 1)
   while the hook read "SLEPT A 2 OUT OF 5". The take was fine; the edit cut away from the truth.
   Fixed by re-timing so Sleep=2 is on screen by 2.24s. See §5 item 4a.
2. **Marcus's context wasn't shown before he used it.** He cites a sore lower back, which really did
   come from the Soreness 3 slider plus the "Lower Back" chip — but the first cut never held that
   state long enough to read. Fixed with the dedicated 1.9s settled hold at 3.70-5.60s, before he
   speaks at 5.75s.
3. **A caption sat on the reply bubble's text at ~20s.** Fixed with `crop_y` 420/450 on the reply
   shots, which scrolls the thread up so the last bubble and its Listen chip finish at y≈1190,
   clear of the caption box. Not by shrinking the footage.
Known cosmetic residue: during the settled readiness hold the caption box covers one *unselected*
sore-area chip ("Shoulders"). The panel is ~1800px tall so some part of it is always under the
caption band; the crop is chosen so every value the video actually claims — the three numbers and
the highlighted "Lower Back" — stays fully visible.

Gotchas that cost time and will again:
- The readiness check only renders when there are **zero `coach_messages` rows for the local day**.
  A direct PostgREST `DELETE` on `coach_messages` returns `204` but deletes nothing (no RLS DELETE
  policy) — use the app's own `POST /api/chat {"mode":"clear_history"}` instead.
- A fresh sign-up already gets a `trialing` subscription from the `create_trial_on_signup` trigger,
  so no service-role provisioning is needed — and Rust's `SUPABASE_SERVICE_ROLE_KEY` is a Vercel
  *Sensitive* var that reads back as the literal `[SENSITIVE]`, so it isn't available anyway.
- `ffmpeg` in this WSL env has **no `drawtext` filter**. Text goes through libass (`subtitles=` with
  `fontsdir=`) for captions and through Playwright HTML→PNG for cards.

**Production note common to all three:** capture the screen recordings from the real
Rust build (Playwright `recordVideo` against a local/staging build, or a native iOS/Android
screen record of the TestFlight/closed-test build) before any further editing — per §4.1, this
is the one gap that has to close before any hook, cover, or caption work in this doc can actually
land.
