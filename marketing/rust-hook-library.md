# Rust Hook Library

Reusable opening lines for video covers, Reel/TikTok text overlays, and caption first-lines. Pull from here instead of writing a new hook from scratch every time.

**What Rust actually is, for reference — verified 2026-09-16 against `Rust/src/pages/Workout.tsx`, `Rust/api/chat.ts` and `Rust/src/components/ReadinessCheck.tsx`:** AI strength coach app, built solo by Heath. Builds workouts around the equipment you actually have (121-item catalog across 10 categories, one-tap presets). You check in daily on sleep/energy/soreness — a **1-to-5 scale, not 1-to-10**. When energy is low or soreness is high, the coach can proactively adjust today's weights, reps or rest time, or swap an exercise entirely, before you ask — these are real tool calls (`adjust_workout`, `swap_exercise`) that write to the database, not just a chat suggestion. Coach personas with real ElevenLabs voice (Marcus "The Powerlifter," etc). Real double-progression logic, per exercise, every session: beat your target reps → +5 lb next time; miss it → hold the same weight; miss badly (under 70% of target) → −10%, rounded to the nearest 5 lb (`Workout.tsx`). **There is no calendar-based deload.** No week counter exists anywhere in the codebase — the closest real thing is the coach occasionally *suggesting* a deload in conversation when volume is high and performance has stalled for 2+ sessions, exactly like a human coach saying it out loud, never an automatic weekly event. Nutrition tracking, community feed, challenges, history/analytics. Reads Apple Health / Health Connect. Status: iOS in App Store review, Android in closed testing, needs 12 opted-in testers.

**Corrections (2026-09-16):** this file previously stated two fabricated capabilities in the block above — "deload every 5th week" and a "1-to-10" readiness slider — flagged as unfixed in `docs/CONTENT-FORMAT-LIBRARY.md` §10.1 item 2 and `docs/RUST-INFLUENCER-PROGRAM.md` item 6 (a creator stating either on camera, with a disclosed material connection, would have been an FTC deceptive-claims problem landing on Heath, not the creator). Both are now corrected here. Hooks #11, #15, #20 and #35 below carried the same fabrications and are corrected in place, marked inline. Everything else in this file was checked against the same code and left as-is where the code supports it (noted per-hook where relevant).

**Re-verification (2026-09-17):** all four 2026-09-16 corrections were independently re-checked against the Rust source and confirmed accurate — the 1-5 sliders (`ReadinessCheck.tsx` renders `[1,2,3,4,5]`), the +5 lb / hold / −10%-under-70% progression rule (`Workout.tsx` lines 373-384 and 1021-1035), the proactive `adjust_workout`/`swap_exercise` calls on soreness 4-5 or energy 1-2 (`api/chat.ts` line 231, persisted via `saveWorkoutPlanExercises`), `add_exercise` creating an exercise that isn't in the library (`resolveOrCreateExercise`), and the 121-item / 10-category catalog (re-counted from `equipmentCatalog.ts`, category-by-category, matches the breakdown below exactly). **One further fabrication was found and fixed: hook #12** — see the note on that hook. Note that `docs/BACKLOG-BUSINESS.md` RM3 describes hooks #11/#15 as also claiming "auto-rewriting of the session (the coach only recommends)"; that half of RM3 is wrong. The coach's tool calls do write to the database, so the corrected #8 and #15 stand. Nothing in this file may cite RM3 as a reason to weaken them.

**Never invent:** user counts, testimonials, results, "X thousand downloads," or specifics not confirmed real (e.g. no made-up "15 minutes a day," no made-up dollar comparisons beyond the one real market anchor — $150/mo human trainers — that's a defensible category price, not a fabricated stat).

**Where the equipment number comes from:** `Rust/src/constants/equipmentCatalog.ts` is the source of truth — count it, don't quote it from memory. As of 2026-09-08 it is **121 items across 10 categories** (Free Weights 15, Selectorized Machines 30, Plate-Loaded 9, Cables 3, Cardio 14, Benches & Racks 12, Bodyweight & Accessories 16, Functional & CrossFit 6, Smart & Connected 10, Studio 6). This file previously said 122, which was wrong and shipped into drafts before it was caught; re-count after any catalog change. Re-verified 121 on 2026-09-16 — unchanged.

---

## Hook principles

1. **Pass the swap test before it goes in the file.** If "Rust" can be replaced with any competitor's name and the line still works, it's not a hook, it's filler. Every hook below has to say something only Rust can truthfully claim.
2. **Lead with the tension, not the noun.** "Fitness app" is not a hook. "It dropped my working weight because I told it I slept 4 hours" is. Open on the specific moment.
3. **The solo-builder fact is the strongest asset Rust has — spend it plainly.** Nobody else posting a fitness app on his feed built the thing themselves. Say "I built this" often, without the startup-pitch varnish around it.
4. **Concrete beats clever.** A real number (12 testers, 121 equipment items, a real progression rule) or a real screenshot-verified behavior always outperforms an abstract line about motivation or potential.
5. **No banned cadence.** Cut on sight: "transform your journey," "game-changer," "revolutionary," "finally," rhetorical questions with obvious answers ("Tired of generic workouts?"), fake-intrigue with no payoff ("Nobody talks about this..."), and any "you don't need X, you need Y" self-help formula.
6. **Say it the way Heath actually talks.** Short sentence, hard stop. Unhedged. Apologizes about logistics, never about the product. If it doesn't sound like something he'd say out loud, rewrite it until it does.

---

## What got cut, and why

Started with a 60-hook draft, cut it to 36 after running the swap-test and scroll-test on every line. What came out:

- **Generic founder-formula lines** ("I made the coach I wanted and couldn't find," "I'm not a fitness influencer, I'm a developer who got tired of bad workout apps") — this exact structure gets used by every solo-dev pitch ever; it doesn't say anything only Rust can say.
- **Unverifiable bravado** ("It's better than apps with actual funding rounds") — an assertion, not evidence. Fails the "genuinely true and specific" bar.
- **Fake-intrigue with no payoff** ("Nobody believes me...", "I didn't expect it to ask me THIS back", "This is the last screenshot I'm posting") — teases a reveal the line itself never delivers.
- **Rhetorical questions with an obvious answer**, or close enough to read as filler ("Your workout app doesn't know you're sore. Mine does.").
- **A fabricated specific** ("fifteen minutes a day") — not a real confirmed number, cut outright rather than risk it becoming a claim.
- **Straight duplicates across categories** — several hooks said the same thing twice with different adjectives (e.g. three separate versions of "the app adjusted my workout when I said one sentence"); kept the strongest phrasing, cut the rest.
- **Explainer sentences masquerading as hooks** ("You don't pick a program, you tell it what you've got and it builds one") — accurate, but it's information delivery, not a scroll-stopper.

What's left below is 36, not 60, because that's what actually cleared the bar.

---

## Founder / solo-builder angle

1. ★ "I built an AI strength coach by myself and now I need you to break it." — *Solo-build fact + honest ask in one line; a funded competitor can't say this. Fits: IG Reel cover, TikTok text overlay.*
2. "Nobody funded this. I coded it nights and weekends because the apps I was paying for were garbage." — *Names the real motivation with a specific complaint, not vague ambition. Fits: FB caption first line.*
3. "This app has exactly one employee and he's typing this caption." — *Genuinely funny, specific, self-aware — only true for a solo build. Fits: FB/IG caption opener.*
4. "Every line of code in this app is mine. So is every bug you're about to help me find." — *Honest framing that turns into the beta ask naturally. Fits: TikTok cover into beta pitch.*

---

## Problem / agitation

5. ★ "Every fitness app you've used gives you the same plan whether you slept 8 hours or 2." — *Universal, specific, sets up the real check-in feature. Fits: IG Reel cover, TikTok text overlay.*
6. "I got tired of apps that ask what equipment you have and then ignore the answer." — *Names a real, specific annoyance, not a category complaint. Fits: FB caption first line.*
7. "PDF workout plans don't know your shoulder still hurts from Tuesday." — *Vivid, concrete, sets up adaptive coaching without needing more explanation. Fits: IG Reel overlay.*
8. "Most 'AI' fitness apps are just a chatbot bolted onto a template. This one actually rewrites your session." — *Verified 2026-09-16: real, code-backed behavior — the coach calls `adjust_workout`/`swap_exercise`, tools that write to the database, not just chat text. Fits: Twitter/X, IG caption.*
9. "You told your last fitness app your knee hurt. It gave you squats anyway." — *Specific, believable, painful — a real gap most apps have. Fits: TikTok text overlay.*
10. "Generic program. Generic results. That's the whole industry." — *Blunt, short, contrarian — matches his unhedged voice. Fits: TikTok cover.*

---

## Curiosity / pattern-interrupt

11. ★ "Watch what happens when I tell my coach my sleep was a 1 out of 5." — *Direct setup for the real, verified screenshot — genuine payoff, not a tease. Corrected 2026-09-16: readiness is a 1-5 scale in the app (`ReadinessCheck.tsx`), not 1-10 — the original line stated a scale that doesn't exist. Fits: IG Reel cover, TikTok.*
12. ★ "I typed 'throw in some calf raises' mid-workout. They were in the session before I finished reading the reply." — *Real, code-verified behavior: `add_exercise` writes the new exercise into today's plan in the database, picks the sets/reps/weight itself rather than asking, and creates the exercise as a custom one if it isn't in the library at all (`api/chat.ts`, `resolveOrCreateExercise`). REPLACED 2026-09-17: this slot previously read "I typed 'I'm gonna do a core and pull day' into my workout app," annotated as verified — it is not. Today's split is chosen from the fixed `SPLITS` picker in `Today.tsx`; there is no free-text entry that generates a session, and the coach has no workout-generation or split-change tool, only per-exercise add/remove/swap/adjust. Fits: TikTok/IG Reel.*
13. "My phone just talked me out of a heavy squat day. Here's why I let it." — *Capability is real (low readiness → the coach lightens or swaps). Only use it if this actually happened to Heath — it's a first-person anecdote, not a feature claim. Fits: IG Reel, FB caption.*
14. "One sentence. Today's workout changes. Watch." — *Ultra-short overlay pairing for the #12 demo video. Corrected 2026-09-17: previously "One rebuilt workout" — the coach edits the session, it does not rebuild it. Fits: TikTok text overlay.*

---

## Specific-feature hooks

15. ★ "Tell it you're wiped and sore and watch it adjust your workout before you even ask." — *States the real, verified behavior as a command: low energy or high soreness makes the coach proactively call `adjust_workout`/`swap_exercise` in its own opening message, before the user asks for anything (`api/chat.ts`). Corrected 2026-09-16 — the original said "sleep was bad" and "drop the weight" specifically; the actual trigger is energy/soreness and the real action can be weight, reps, rest time, or a full exercise swap, not only weight. Fits: TikTok/IG Reel cover.*
16. "121 pieces of equipment in the catalog. One tap if you've only got dumbbells and a bench." — *Real, specific number no competitor can honestly borrow. Fits: FB caption, IG caption.*
17. "The coach has a voice. Marcus the powerlifter actually talks you through your set." — *Novel, real feature (ElevenLabs persona), names the persona directly. Fits: TikTok/IG Reel.*
18. "It doesn't just log your workout — it remembers your last PR and brings it up unprompted." — *Verified real behavior from the app's own dialogue. Fits: IG Reel cover.*
19. "Real double progression — it backs off automatically when you miss reps, no spreadsheet required." — *Speaks directly to lifters who know what bad progression logic looks like; real, specific, matches the code-verified rule. Fits: Twitter/X, FB (lifter audience).*
20. "Ask for an exercise that isn't even in its library and it builds it on the spot, mid-workout." — *Real, verified behavior — `add_exercise` auto-creates a genuinely new custom exercise if it isn't already in the catalog (`api/chat.ts`). REPLACED 2026-09-16: this slot previously read "Deload week hits automatically every 5th week," a fabricated feature — no calendar deload or week counter exists anywhere in the codebase. Fits: TikTok cover, IG Reel.*
21. "Mid-set, tap the exercise, get a real coaching cue and a video without leaving your workout." — *Pulled from the app's real behavior (verified in the produced video script). Fits: TikTok cover, IG Reel.*
22. "It reads your Apple Health steps and heart rate so it's not guessing how hard yesterday actually was." — *Concrete integration detail, not a vague "syncs with your phone" claim. Fits: FB caption.*

---

## Beta recruitment specific

23. ★ "I need 12 Android people to break my app before Google will let me launch it." — *Real, specific number and real constraint — this is literally the ask. Fits: FB post first line, IG caption.*
24. "Free app. Real AI coach. All I need back is that you actually use it and tell me what's broken." — *Clear value exchange, no strings framing, matches his real posted copy. Fits: FB caption.*
25. "Android only — I've got iPhone covered, I promise. If you're on iPhone, hang tight." — *Filters the wrong audience fast, avoids wasted comments — functional but necessary as a first line. Fits: FB/IG post first line.*
26. "This is free right now specifically because I need your help, not because it's a discount." — *Reframes "free" as a real partnership, not charity. Fits: IG caption.*
27. "Send me your Gmail, I'll add you to the beta today." — *Zero-friction literal CTA, best as a closing line or on repost/reminder posts. Fits: FB comment-bait, Twitter.*
28. "Looking for Android strength trainers willing to poke holes in something I built." — *Targets lifters specifically, not general fitness scrollers. Fits: Reddit-style post (r/homegym, r/androidapps), FB.*

---

## Provocative / contrarian

29. ★ "Your $150/month personal trainer reads your check-in for ten seconds. This app actually reads it." — *Real market price anchor + a claim people will want to argue with. Fits: TikTok cover, Twitter/X.*
30. "Most fitness apps are a subscription wrapped around a PDF. This one isn't." — *Names the category's actual business model bluntly, true of most template-based apps. Fits: FB caption, Twitter.*
31. "'AI fitness coach' has become a scam term. Here's what it should actually mean." — *Calls out the category's marketing noise without naming names, sets up a real demo. Fits: TikTok text overlay, IG Reel.*
32. ★ "I'll say it: most workout apps are lazier than the people using them." — *Blunt, quotable, matches his real "when pushing back he goes unhedged" texting pattern. Fits: Twitter/X.*
33. "A program that never changes isn't personalized. It's just a PDF with your name at the top." — *Sharp, true, quotable one-liner. Fits: IG Reel cover, Twitter.*

---

## Results / transformation framing (earned claims only)

34. "I'm not going to show you a before/after. I'm going to show you the coach adjusting my actual workout." — *Honest reframe away from unearned transformation claims — still a real hook. Fits: IG Reel cover.*
35. ★ "I stopped guessing what weight to load next. The app already knows from last time." — *Personal, true, specific — framed as behavior change from the real, code-verified double-progression rule (+5 lb / hold / −10%), not a body-result claim he hasn't earned. Corrected 2026-09-16 — the original claimed "deload weeks," a calendar feature that doesn't exist in the app. Fits: TikTok/IG Reel cover.*
36. "The only progress I can promise: the app remembers what you did last time so you don't have to." — *Honest, understated, true feature framed as relief rather than a fabricated outcome. Fits: FB caption, Twitter.*

---

## Starred picks — the 10 strongest to lead with

- #1 "I built an AI strength coach by myself and now I need you to break it."
- #5 "Every fitness app you've used gives you the same plan whether you slept 8 hours or 2."
- #11 "Watch what happens when I tell my coach my sleep was a 1 out of 5."
- #12 "I typed 'throw in some calf raises' mid-workout. They were in the session before I finished reading the reply."
- #15 "Tell it you're wiped and sore and watch it adjust your workout before you even ask."
- #21 "Mid-set, tap the exercise, get a real coaching cue and a video without leaving your workout."
- #23 "I need 12 Android people to break my app before Google will let me launch it."
- #29 "Your $150/month personal trainer reads your check-in for ten seconds. This app actually reads it."
- #32 "I'll say it: most workout apps are lazier than the people using them."
- #35 "I stopped guessing what weight to load next. The app already knows from last time."
