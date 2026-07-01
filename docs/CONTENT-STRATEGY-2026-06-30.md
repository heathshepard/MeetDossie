# Dossie Content Strategy — Screen Recording + Voiceover Pipeline

Locked 2026-06-30 by Heath directive (Chamonix). Replaces all persona-driven (Brenda/Patricia/Victor) and auto-generated text+image-card posts. Authored by Sage. PENDING HEATH APPROVAL before any post under this strategy ships.

> **UPDATE 2026-07-01 — Bucket B (founder-face) is DEPRECATED.**
>
> Heath directive 2026-07-01 10:17 CDT: *"I just want screen recordings for now. Showing off dossies capabilities."*
>
> Bucket B (Heath on-camera selfie clips + Heath original audio) is retired as of today. All customer-facing video reverts to:
> - **Bucket A — Product walkthroughs** (screen recording + Luna voiceover) — now ~85% of volume
> - **Bucket C — Customer evidence** (Luna reads verified customer quote + screen recording) — ~15% of volume
>
> Selfie/founder-face source clips (`still-an-agent-selfie-2026-05-25.mp4`, `where-are-we-selfie-2026-05-25.mp4`, `youre-the-tc-selfie-2026-05-25.mp4`, `italy-selfie-v3-2026-05-29.mp4`) are shelved. Heath's verified pain stories can still land as HOOK content — Luna reads them, no on-camera Heath.
>
> New script batch: `docs/VIDEO-SCRIPTS-V001-V005-2026-07-01.md` (feature demos, Luna throughout).
> Old script batch: `docs/VIDEO-SCRIPTS-V001-V002-V003.md` — DEPRECATED.

---

## 1. What changed

**Killed (2026-06-30):**
- `cron-generate-posts` (11 UTC) — auto-generates 9 brand-voice posts/day. Paused via `posting_schedule.is_active=false` on all 6 platforms.
- `cron-sage-research` (12 UTC) — RSS-trend persona drafts (persona='victor'/'brenda'). Paused via same gate; needs code change before unpause.
- `cron-daily-fb-posts` (14 UTC) — same gate.
- 60 in-flight drafts/approved posts (18 future-scheduled + 42 stale drafts) → status=rejected with audit reason. Preserved as historical data, NOT deleted.

**Surviving:**
- Founding Files FB group (private member group) — separate pipeline via `fb-group-poster.js`, not affected.
- Tutorial video crons + skits pipeline — separate content type, untouched.
- Engagement crons (commenting on others' posts) — separate behavior, untouched.

---

## 2. The new pipeline (proposed)

Every customer-facing social post originates from one of three buckets:

### Bucket A — Product walkthroughs (60% of volume)
- **Source:** A screen recording from `Media/screen-recordings/` showing Heath's actual hands on Dossie executing a specific job (morning brief load, pipeline scroll, TREC deadline calc, draft-email queue, Talk-to-Dossie).
- **Voiceover:** Dossie's voice (Luna `lxYfHSkYm1EzQzGhdbfc`, ElevenLabs) narrating the action in second-person ("You wake up. You ask me what's due today. Here's what I send back.").
- **Length:** 25-45 seconds. Hook in first 1.5s = on-screen action + voice line. End frame = single CTA card.
- **Why it works:** literal demonstration beats persona narration every time. Viewer sees the product working, voice tells them what they're seeing.

### Bucket B — Founder pain stories (25% of volume)
- **Source:** Heath on camera (selfie video, mobile portrait) — `still-an-agent-selfie-2026-05-25.mp4`, `where-are-we-selfie-2026-05-25.mp4`, `youre-the-tc-selfie-2026-05-25.mp4`, `italy-selfie-v3-2026-05-29.mp4` already filmed. Three verified stories: Italy/TC-quit, $400-per-file/4:30am, Vacation-stress-test.
- **Voiceover:** Heath's own captured audio from the selfie clip. NO AI voice overlay — authentic founder narration only.
- **Length:** 30-50 seconds.
- **Why it works:** verified, specific, visceral. From `project_heath_founder_pain_stories.md`.

### Bucket C — Customer evidence (15% of volume)
- **Source:** Brittney YBarbo's verified quote ("the lack of systems I have in place isn't sustainable") and onboarding-day quote screenshots. Cecilia/Miki/Natalie if/when they say something quotable.
- **Voiceover:** Dossie (Luna) reading the quote + framing it. Never put words in a customer's mouth.
- **Length:** 20-35 seconds.
- **Why it works:** real customer language, no fabrication, anchors the social-proof angle.

---

## 3. Per-platform cadence (proposed)

| Platform | Frequency | Bucket priority | Format |
|---|---|---|---|
| Facebook (page) | 2/week | A → B → C | Square video, captions burned in, link in first comment |
| Founding Files FB group | 1/week | B → A | Native video + 1-line founder note (pipeline already exists) |
| Instagram | 2/week | A → B | Portrait 9:16 reel, captions burned in, 8-10 hashtags |
| LinkedIn | 1/week | B → A | Landscape or square, 60-90s, Heath as CEO from his account (no persona) |
| TikTok | 2/week | A → B | Portrait 9:16, captions burned in, 3-5 hashtags |
| Twitter | 1/week | A → C | Square video + 1 sentence + 2 hashtags |
| YouTube | PAUSED | — | Resume after 30 days of Bucket A/B/C performance data |

**Total: ~9 posts/week (down from ~63/week)**. Heath's directive: "1 high-quality screen-recording-driven post per platform per week beats 5 persona auto-posts/day."

---

## 4. Three sample posts (for Heath's approval)

### SAMPLE 1 — Bucket A — Facebook (Wed 2026-07-01 16:00 UTC)
**Source recording:** `Media/screen-recordings/morning-brief-desktop-2026-05-04.mp4`
**Voiceover (Luna, ~22s):**
> "Six a.m. You're not awake yet. I am. I read every contract in your pipeline overnight, flagged what's due today, and recorded a brief you can listen to while the coffee brews. Tap play. I'll tell you what needs you, and what I already handled."
**Caption:**
> Mornings used to be a panic scroll. Now they're an audio brief that knows the deals before you do. Dossie reads contracts overnight so you wake up to a summary, not a scramble.
**CTA in first comment:** "Founding Member spots — meetdossie.com/founding"

### SAMPLE 2 — Bucket B — Instagram + Founding Files FB group (Thu 2026-07-02 17:00 UTC)
**Source clip:** `Media/finished-videos/italy-selfie-v3-2026-05-29.mp4` (Heath on camera, 30s)
**Voiceover:** Heath's original audio (no overlay).
**Caption:**
> I was in Italy when my transaction coordinator quit. Mid-escrow. Seven hours behind my files. That trip is the reason Dossie exists. She doesn't quit. She doesn't sleep. She doesn't have a time zone.
**Hashtags (IG only):** #txrealtor #realestate #transactioncoordinator #texasrealestate #realtorlife #trec #meetdossie #dossietc

### SAMPLE 3 — Bucket A — TikTok (Fri 2026-07-03 13:00 UTC)
**Source recording:** `Media/screen-recordings/talk-to-dossie-mobile-2026-06-11.mp4`
**Voiceover (Luna, ~18s):**
> "You don't have time to type. You're driving to a showing. So you tell me what changed. I update the deal. I draft the email. I tell you what I sent. That's it. That's the whole feature."
**Caption:** "Voice → updated deal → drafted reply. 14 seconds of work."
**Hashtags:** #transactioncoordinator #texasrealtor #realestatetips #trec

---

## 5. Production pipeline (who does what)

| Step | Owner | Tool |
|---|---|---|
| 1. Pick the recording + bucket | Sage | `Media/screen-recordings/LIBRARY.md` index |
| 2. Write the voiceover script (Luna OR Heath audio) | Sage | Markdown brief, max 50 words |
| 3. Render voiceover (Luna) | Carter pipeline | ElevenLabs API, voice `lxYfHSkYm1EzQzGhdbfc` |
| 4. Assemble video (recording + voice + captions + CTA card) | Carter pipeline | Creatomate template `791117d0-665c-4cd0-ba5f-a767f8921f9b` OR new lightweight ffmpeg recipe |
| 5. Burn captions in (mandatory FB/IG/TT — 85% watched muted) | Carter pipeline | Submagic upload (manual until API plan upgrade) OR ffmpeg subtitle filter |
| 6. Queue to Zernio with platform-correct aspect | Carter pipeline | Existing `cron-post-videos` after platform unpause |
| 7. Approval ping | DossieMarketingBot | Telegram approve/reject before publish |

**Carter is being briefed in parallel** to rewire steps 4-6 so Sage can drive script + clip selection without rebuilding the video pipeline.

---

## 6. What we are NOT doing

- No fabricated stats, member counts, testimonials, or timestamps (per `feedback_no_fabricated_specifics`).
- No persona narration (Brenda/Patricia/Victor) anywhere, ever. Personas are dead in customer-facing copy.
- No multi-feature stacking — one feature per post.
- No "I just learned that…" framing — Heath speaks from authority.
- No links inside the main post body on Facebook — link in first comment only (algo-friendly).
- No YouTube posts until we have 30 days of A/B/C engagement data to compare.

---

## 7. Approval gate

Nothing under this strategy ships until Heath texts back: "Approved, run it." Until then the platform pause stays in place. Sage will not unpause `posting_schedule.is_active` without explicit Heath authorization (memory rule `feedback_autonomous_problem_solving` — strategy decisions are Heath's).

---

## 8. Open items requiring Carter

1. Patch `cron-sage-research` to drop persona='victor'/'brenda' attribution (or kill the cron outright).
2. Build the new lightweight video assembly recipe (screen recording + Luna voice + captions + CTA card) — Creatomate template may suffice with new field mappings.
3. Add a `posting_schedule_killswitch` admin button so Sage can pause/unpause from the dashboard without SQL.
4. Update `cron-generate-posts.js` POST_PLAN_BASE comment block to reflect new buckets (or retire the cron).

Sage owns content strategy. Carter owns pipeline code. This file is the strategy spec.
