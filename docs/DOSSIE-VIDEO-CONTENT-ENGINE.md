# Dossie Video Content Engine

Owner: Sage. Written 2026-09-14 in response to Heath's brief: the hard video
gate is going in at the publish step (no more static/text posts), which makes
**video supply** the binding constraint on cadence. This doc is the pillar
plan for the 8 formats Heath named, what's actually buildable/built today,
and the honest weekly-output number.

**Read alongside:** `docs/VIDEO-RULES.md` (pipeline mechanics, posting
schedule, media folder layout), `docs/PIPELINE.md` (posting cron chain),
`heath-voice-clone-settings-locked.md` memory (exact ElevenLabs config).

---

## 0. The headline finding: there is already unposted supply sitting idle

Before anything else — `video_library` right now (queried live, 2026-09-14):

| status | count |
|---|---|
| posted | 14 |
| pending_approval | 9 |
| pending_heath_review | 4 |
| heath_approved | 3 |
| failed | 1 |

**16 real, finished, video-gate-compliant videos are sitting unposted today**,
7 of which (`heath_approved` + `pending_heath_review`) are one Telegram tap
or one cron cycle away from going out. That's not a future-state number —
that's Thursday's post, Friday's post, and most of next week's, already
sitting in Supabase Storage. The "video supply problem" this doc solves is
mostly a NEW-content problem, not a zero-content problem — check
`video_library where status in ('heath_approved','pending_heath_review')`
before spinning up any new production run.

(Caveat: this existing batch is narrated in **Bill's voice**, not Heath's —
it predates today's voice-rule change. See §1 for the call I'm making on
whether to re-narrate it.)

---

## 1. Format-by-format plan

### Format 1 — Feature demos (screen recordings, founder-narrated)

**What it is:** Playwright drives the live demo account (`demo@meetdossie.com`,
Sarah Whitley) through a scripted UI flow and records it; ElevenLabs narrates
over it.

**Pipeline (fully exists, reused as-is):**
`scripts/feature-demo-scenes/*.json` (scene script: viewport, demo account,
click/type steps, voiceover text) → `scripts/feature-demo-recorder.js`
(Playwright, **fully automated recording** — no human touches the screen) →
`scripts/feature-demo-merge.js` (voiceover + align + render mp4) →
`scripts/feature-demo-publish.js` (upload to Storage, insert `video_library`
row, `status='pending_approval'`) → existing Telegram approval → Zernio.

**What I changed today:** `feature-demo-merge.js` now resolves voice through
`voice-select.js` when a scene sets `"voice": "heath"` — Heath's actual clone,
locked eleven_v3 settings, `contentType: 'feature_demo'`. Every existing scene
JSON still says `"voice": "bill"` and is untouched; this is additive. **New**
scenes should set `"voice": "heath"` per Heath's brief ("narrated in Heath's
voice as the founder"). I added a hard refusal if the TTS call ever silently
falls back to OpenAI/PlayHT for a `heath`-voiced scene — a generic fallback
voice mislabeled as Heath's clone is worse than a failed render.

**Open call, not mine to make:** the 16 pieces of banked-but-unposted supply
in §0 are narrated in Bill's voice under the old rule. Re-narrating all of
them costs ~16 ElevenLabs calls (cheap) but re-renders the audio-synced video
timing (not free — `feature-demo-merge.js` aligns cuts to voiceover length).
**My recommendation:** ship the 16 as-is (they're real, approved-quality,
video-gate-compliant — Bill is still a legitimate Dossie voice), and apply
the Heath-voice rule to everything produced from today forward. Don't burn a
day re-rendering a backlog that solves the actual supply problem right now.

**Automation level:** highest of all 8 formats. Recording is unattended.
Human input needed: (a) write/approve the scene's click-path + narration
script (an agent can draft this from the app's real UI — Carter's domain if
new demo-account state is needed), (b) Heath's one-tap Telegram approval on
the finished video. No camera, no Heath screen time.

**Realistic output:** 2-3 new scenes/week sustainably (bottleneck is writing
new accurate scene scripts + demo-account state that supports them, not
render time — a render is ~3-5 min unattended).

---

### Format 2 — Conversations between Dossie and Heath

**Heath's call: "I think you nailed my voice... I think this is the
strongest idea in the list."** Built a real, working prototype today — see
§2 below for the full design writeup, the actual file, and how to watch it.

**Automation level:** high once a script exists. The bottleneck is the
same as format 1 — a script has to be written and approved (this one is
higher-stakes since it's literally Heath's voice making claims), not the
render. Render is ~3-4 min unattended once turns are written.

**Realistic output:** 1-2/week. Scripts should run 4-6 short turns (see
§2's design note on the sample running long).

---

### Format 3 — Texas real estate market stats/updates over b-roll

**What it needs:** current, real Texas market data (not fabricated stats —
VIDEO-RULES.md's existing rule "no unverified stats, numbers framed as
hypotheticals" needs to flip to "numbers ARE verified, cite source" for this
format specifically, since the whole point is real market updates) + Pexels
Texas b-roll (skyline, neighborhoods, moving trucks, for-sale signs) +
Heath's voice narrating as founder.

**Pipeline (reused, not rebuilt):** Pexels fetching + ffmpeg b-roll assembly
already exists in `scripts/generate-lifestyle-video.py`. **What I changed
today:** added `--voice-name-override` (new CLI flag) and a `"heath"` entry
to `VOICE_REGISTRY` (locked eleven_v3 settings) — the script refuses the
override if it resolves to a `brenda`/`patricia`/`victor` persona row, so
Heath's clone structurally cannot land on a customer-persona post. **Real
constraint I didn't paper over:** this script hard-requires a
`content_calendar` row (topic/hook/voiceover_script) to exist before it will
render anything, even with CLI overrides — it's coupled to the 25-row
5-week persona calendar, not a general-purpose tool. Market-stat/city/law/
industry topics need their own `content_calendar` rows inserted (persona
left `NULL`) before this pipeline can point at them. That's a data-entry
step, not a code gap, but it's real work per topic — budget for it.

**Sourcing:** stats need a real citation (TAR/MetroTex/local MLS reports,
Texas Real Estate Research Center at Texas A&M, Census/BLS for
employment-adjacent claims). Heath's license makes an overstated/stale
market claim a real problem, not just a bad look — same posture as trivia
(§4).

**Realistic output:** 1/week. Current data worth narrating doesn't refresh
faster than that, and each one needs a real source check.

---

### Format 4 — Industries/employers moving to Texas

**What it is:** same b-roll+narration mechanics as format 3, different
research input (relocation announcements — Tesla-style, named employers,
job numbers).

**Sourcing:** WebSearch for verified relocation/expansion announcements
(company press releases, TX Governor's office economic development
announcements, Dallas/Austin/Houston business journal coverage) — never a
number Sage invents. Thin content pool: real, checkable relocation news
doesn't happen weekly at the volume needed for a weekly cadence.

**Realistic output:** 1 every 2 weeks, opportunistic (produce when there's
real news, not on a forced schedule) rather than 1/week padded with weak
stories.

---

### Format 5 — Real estate law updates

**Same b-roll+narration mechanics, highest legal-accuracy bar of the b-roll
formats.** TREC rule changes, statute updates, contract form revisions don't
happen weekly. **Recommendation: bank these as they occur** (Heath already
tracks TREC form changes for his own license — this is the same monitoring,
repurposed) rather than forcing a cadence that would eventually manufacture
non-news or, worse, mischaracterize a minor update as bigger than it is.

**Realistic output:** 1 every 2-3 weeks, event-driven.

---

### Format 6 — Contract trivia / scenario quizzes

**Heath's ask: for FB groups specifically, engagement-driven ("people argue
in comments").** See §3 for the full verification-gate design — this is the
format with the most legal exposure per piece (a wrong answer under Heath's
license, stated as fact, in his own voice) and gets its own section rather
than a one-liner.

**Realistic output:** 1-2/week once an initial verified question bank exists
(batch-verify 8-10 scenarios in one legal-review pass, then produce from the
bank weekly — don't verify one-at-a-time under a weekly deadline).

---

### Format 7 — City-level Texas content

**Same b-roll+narration mechanics as formats 3-5**, but with a real content
advantage: Texas has ~40+ metros/cities worth a "why someone would move here"
video, so this is the one format in the b-roll group that CAN sustain a
weekly cadence without running out of real material (McAllen this week,
Tyler next week, etc. — see Heath's own list). Content risk is lower too —
"why people move to [city]" is lifestyle/informational, not a stat that goes
stale or a legal claim that needs a citation, so this can run closer to
autopilot than formats 3-5 once b-roll queries per city are mapped.

**Realistic output:** 1/week sustainably — this is the strongest candidate
of the four b-roll formats for a locked weekly slot.

---

### Format 8 — Founder story

**Fully manual, and should stay that way** — this is Heath on camera
explaining why he built Dossie, and a synthetic version of that would defeat
the entire point (authenticity is the content). Production pipeline already
exists and needs no new code: `scripts/SELFIE-VIDEO-WORKFLOW.md` (phone →
Submagic auto-captions/auto-b-roll → optional Creatomate outro →
Zernio). Heath records, Submagic and the existing Telegram approval flow do
the rest.

**Realistic output:** 1/month. This is bounded by Heath's actual camera time,
not pipeline capacity — don't force more than that. One good founder-story
asset can also be re-cut into 2-3 shorter clips (different pull-quotes) to
stretch its shelf life across weeks.

---

## 2. Format 2 deep design + prototype — Heath <-> Dossie conversations

### Why this format is different from the other 7

Every other format is one narrator over visuals. This one is a real
back-and-forth: Heath asks something a working agent would actually ask,
Dossie answers with what she actually does. That's dramatization instead of
description, and it's the only format where the product's voice (Luna) and
the founder's voice (Heath's clone) both appear in the same piece — which is
exactly why the brand-separation rule needed a real update today (see
`scripts/voice-select.js`) rather than a one-off exception.

### Design decisions

1. **No fake video of "Heath" or "Dossie."** There's no footage of Dossie to
   fake (she's software) and generating an AI avatar of Heath would be a
   worse misrepresentation than the Ken Burns-vs-Kling tradeoff already
   documented in `generate-listing-video.js` — an AI double of a real
   licensed person making claims on camera is a much bigger problem than a
   warped countertop. **Visual treatment is captioned dialogue cards
   instead**: full-bleed brand-color cards (Navy for Heath, Blush for
   Dossie per CLAUDE.md §4) with a speaker label and the line as on-screen
   text, timed to that turn's real audio. This also happens to match how
   people actually consume Reels/TikTok (sound-off, captions-on).
2. **Two real voices, never swapped.** Heath's turns route through
   `voice-select.js` (`contentType: 'conversation_heath'`) — his actual
   clone, locked settings. Dossie's turns are hardcoded to Luna, same
   voice/settings `feature-demo-merge.js` already uses for her. The script
   hard-refuses (throws, doesn't silently substitute) if either side's
   ElevenLabs call falls back to a different TTS provider.
3. **Pacing:** 0.3s gap between turns (same beat produce-skits.py uses for
   skit dialogue — proven to read as natural, not robotic).
4. **CTA:** closing card says "This is Dossie." + `meetdossie.com/signup` —
   **not** `meetdossie.com/founding`. Flagged separately below; several
   older scripts still hardcode the closed offer.

### What I built

`scripts/generate-conversation-video.js` — full pipeline, ran it end to end
today (not a mockup):

1. Per turn: synth via `api/_utils/tts.js` (`generateSpeech`), Heath's clone
   or Luna depending on speaker.
2. `ffprobe` each turn's real duration.
3. Per turn: a silent ffmpeg card sized to that duration + gap. **Note:**
   this WSL ffmpeg build (`johnvansickle` static 7.0.2) has no `drawtext`
   filter compiled in despite `--enable-libfreetype` — confirmed via
   `ffmpeg -filters`. Captions render as `libass` ASS-subtitle events
   instead (same visual result, this build does have `libass`). Worth
   knowing before any other script on this box assumes `drawtext` works.
4. Concat all turn cards + a closing CTA card into one silent video track;
   concat all turn audio (with silence gaps matching the video) into one
   audio track; mux.

**Sample script:** `scripts/conversation-scripts/conversation-option-period-2026-09-14.json`
— Heath asks about an option-period deadline on "Ranch Road," Dossie
explains what happens if it's missed and how she's tracking it, closes on
the capability beat. Content is plain, well-established TREC 1-4 contract
mechanics (option period = unrestricted right to terminate for the option
fee, calendar days, effective-date-driven) — nothing novel enough to need
the trivia-style legal verification in §3, but the pattern (verify before
Heath's voice states a legal fact) is the same one to apply to every real
episode.

**Real output, actually rendered, not posted:**
`Media/conversations/conversation-option-period-2026-09-14-vertical.mp4` —
1080x1920, h264+aac, confirmed via ffprobe. **Duration: 60.4s.** That's the
one concrete lesson from the prototype: **the 7-turn sample script ran too
long.** VIDEO-RULES.md's 30-45s norm implies conversation scripts need to be
tighter than natural dialogue tends to run — 4-5 short turns, not 7. I did
not trim the sample to hit the target; that's a scripting-discipline note
for whoever writes the next one, not a pipeline bug.

**Watch it before this becomes a real format** — that's Heath's call, same
as the three listing videos he reviewed before those got approved.

### Open design questions for Heath

- Caption card aesthetic is intentionally plain (solid color + text) for the
  prototype. A polish pass (subtle motion, a small avatar glyph, a
  waveform-style pulse under the speaking line) is a follow-on, not a
  blocker — the audio is the hard part and it's proven.
- Talking-head upgrade path exists later (Heath on camera for his half,
  captions/cards for Dossie's half) if the card-only version underperforms —
  not needed to ship v1.
- Episode topics: recommend sourcing from real support/onboarding questions
  Dossie customers actually ask (there's a real question bank forming in
  production usage) rather than inventing hypothetical Q&A every week.

---

## 3. Contract trivia — source of truth + verification gate

This is the format with the most legal exposure per piece: a wrong answer,
stated as fact, in Heath's actual voice, under his TREC license, in a public
Facebook group where "people argue in comments" (Heath's own framing of why
this format works) means a wrong answer gets amplified, not just missed.

### Proposed source of truth

Don't write trivia from memory or a general LLM prompt. Anchor every
question to something already verified in this codebase:

1. **`api/cron-deadline-reminders.js`** — the canonical, already-in-
   production deadline logic (option period, appraisal, survey, HOA
   documents, loan approval, option-fee/earnest-money delivery under TREC
   ¶5.A) with `computeFundsDeliveryDueDates()` doing the actual date math.
   This has already been debugged against real transactions — it's a better
   source than re-deriving deadline math from scratch for a trivia question.
2. **`api/_lib/fill-trec-20-19.js` / `api/_lib/trec-20-19-field-metadata.js`**
   — real TREC 20-19 field semantics (what each paragraph actually says/
   requires) for scenario questions ("buyer wants to terminate on day 4 of a
   7-day option period, what are their options").
3. **TREC's own published forms + Texas REALTORS legal FAQ** as the final
   check for anything not already encoded in the two sources above.

### Proposed workflow

1. **Draft** — pull a real deadline/paragraph mechanic from source #1 or #2
   above, draft a scenario ("your buyer's earnest money hasn't been
   delivered and it's day 4 — what's the status of the contract?") + the
   correct answer + 2-3 plausible wrong answers, with the citation
   (paragraph number, or the exact code path/column that computes it).
2. **Verify** — every question needs an explicit Heath (or attorney) sign-off
   before it renders, not after. Add a `status='pending_legal_review'` gate
   analogous to the existing `pending_heath_review` video_library status —
   the render step should refuse to run on a question row that isn't marked
   verified, the same way `feature-demo-merge.js` now refuses a silent TTS
   fallback for Heath's voice. Batch this: verify 8-10 at once in one
   sitting rather than one-per-week under deadline pressure, which is how a
   wrong answer slips through.
3. **Produce** — once verified, this reuses the exact card-based visual
   pattern built for format 2 today (a "reveal" card format is a one-line
   variant: question card → pause/hold → answer card with the citation
   shown on-screen, not just spoken). Heath's cloned voice hosts it
   (`contentType: 'trivia_host'`, already wired into `voice-select.js`).
4. **Post to groups, not the main feed** — Heath specifically wants these in
   FB groups for the comment-argument engagement effect, which is a
   distribution decision (Sage's call at post time), not a production one.

### What I did NOT build today

A working trivia-question generator/verifier. That needs either Heath's or
an attorney's actual sign-off loop, which is a process to design and get
buy-in on, not a script to run unattended — building the generation half
without the verification gate would be building the risky half first. The
production/render half (once a question is verified) is a ~30-minute reuse
of the format-2 pipeline whenever that's wanted.

---

## 4. Voice rule changes — what actually shipped

`scripts/voice-select.js` — `getVoiceIdForOwner(targetOwner, {contentType})`:

- `target_owner='heath-realtor'` — unchanged, always approved (his own
  listing content).
- `target_owner='dossie'` + `contentType` in `DOSSIE_FOUNDER_CONTENT_TYPES`
  (`feature_demo`, `conversation_heath`, `market_update`,
  `industry_relocation`, `law_update`, `trivia_host`, `city_spotlight`,
  `founder_story`) — **newly approved**, Heath's clone.
- Everything else (persona posts, Dossie's own dialogue lines) — still
  `null`, still routes to Bill/Luna. Luna never voices Heath's realtor
  content — that block was already enforced in `gen-listing-voiceover.py`'s
  `BANNED_VOICE_IDS` and is untouched.
- Returns the full locked config now (`eleven_v3`, stability 0.3, style 0.4,
  speaker_boost on, 0.9-1.15x speed guard, pronunciation map path) instead
  of just a voice ID, so every new caller gets Heath's approved settings by
  default instead of re-deriving them.

Wired into two real render paths today: `scripts/feature-demo-merge.js`
(scene `"voice": "heath"`) and `scripts/generate-conversation-video.js`
(speaker `"heath"`). `scripts/generate-lifestyle-video.py` got an additive
`--voice-name-override` flag + a `"heath"` `VOICE_REGISTRY` entry, refused
if it would land on a persona row.

**Both new integration points hard-refuse a silent TTS provider fallback**
for Heath's voice (ElevenLabs down/quota'd → would otherwise ship OpenAI's
generic `onyx`/`nova` mislabeled as Heath — worse than a failed render).

---

## 5. Stale-content flag (found while building this, not fixed — scope call)

`docs/VIDEO-RULES.md`'s closing convention and `scripts/produce-skits.py`
(8 occurrences: `CTA_REQUIRED_SUBSTRING`, two dialogue lines, the CTA card
text, two caption fallbacks) still hardcode **`meetdossie.com/founding`** /
"meetdossie.com slash founding" as the required CTA, and the skit CTA card
literally renders `"{N} founding spots left"` from a live Supabase count.
Founding closed to new signups 2026-08-04 (CLAUDE.md §5) — **any skit
rendered today would advertise a closed program with a live-but-meaningless
scarcity counter.** I did not touch `produce-skits.py` — swapping the CTA
URL is a one-line-per-occurrence fix, but the scarcity MECHANIC (spots-left
counter) needs a real replacement offer decision, which is a pricing/funnel
call outside this task's scope. My own new script uses
`meetdossie.com/signup` throughout. Flagging for Heath/Carter before the
skit pipeline runs again.

---

## 6. The supply math — the number Heath actually asked for

**Daily posting caps today** (`docs/VIDEO-RULES.md`): FB 2, Twitter 3, IG 1,
LinkedIn 1, TikTok 1 = 8 platform-slots/day. One landscape/square video can
legitimately fan out to FB+Twitter+LinkedIn (3 slots) per the existing
feature-demo convention (`platforms: ["facebook","twitter","linkedin"]`);
one vertical video fans out to IG+TikTok (2 slots). **Fully saturating all 8
slots every single day under a hard video gate would take roughly 3-4
distinct video assets/day (≈21-28/week)** — that is not realistic across 8
research- and accuracy-gated formats, and I'm not going to pretend it is.

**What's actually achievable, format by format (steady state, once each
format's script/research bottleneck — not render capacity — is fed):**

| Format | Realistic/week | Heath's real involvement |
|---|---|---|
| 1. Feature demos | 2-3 | Script/scene approval + 1 Telegram tap. No camera time. |
| 2. Conversations | 1-2 | Script approval (his voice = his claims) + 1 tap. No camera time. |
| 3. Market stats | 1 | Source-check the stat before it renders. No camera time. |
| 4. Industry relocation | 0.5 (1/2wk) | Source-check the news item. No camera time. |
| 5. Law updates | ~0.35 (1/3wk) | Source-check + his own legal read. No camera time. |
| 6. Contract trivia | 1-2 (after initial verify batch) | Legal-accuracy sign-off, batched. No camera time. |
| 7. City spotlights | 1 | Light review only — lowest-risk b-roll format. No camera time. |
| 8. Founder story | 0.25 (1/mo) | Full manual recording — this one is his camera time. |

**Total: roughly 7-11 net-new pieces/week at steady state, none of which
require Heath on camera except format 8.** That comfortably covers a 4-5
day/week production cadence (1 flagship asset/day, cut to both aspect
ratios where the format supports vertical) rather than 8 forced slots on
every single platform every single day.

**Direct answer to "3-4/week vs daily":** the honest number is closer to
**daily on the high-leverage formats (1, 2, 7) and weekly-or-slower on the
accuracy-gated ones (3, 4, 5, 6, 8)** — call it **5 production days/week**
as the sustainable target, each day's asset covering 2-5 platform slots via
aspect-ratio fan-out, which is a real cadence drop from the current 8-slot/
day text-post target but is genuinely sustainable with video, not a
one-week burst that collapses. **Today's actual floor is even better than
that** — §0's 16 banked, unposted videos mean the next ~1-2 weeks of
cadence is already produced and just needs approval taps, buying real time
to get formats 2, 6, and 7 (the next-highest-leverage new formats) into
steady production before the backlog runs out.

---

## 7. What's built vs. what's plan-only

**Built and tested today:**
- `scripts/voice-select.js` — rewritten, brand-separation gate opened for
  named Dossie founder/instructional content types, tested via direct
  function calls.
- `scripts/feature-demo-merge.js` — wired to `voice-select.js` for
  `"voice": "heath"` scenes, with a hard anti-silent-fallback guard.
  Syntax-checked; not run end-to-end (would need a new Playwright recording,
  out of scope for the prototype pass).
- `scripts/generate-lifestyle-video.py` — additive `--voice-name-override`
  + `"heath"` `VOICE_REGISTRY` entry + persona-conflict refusal. Compiles;
  not run end-to-end (needs a `content_calendar` row for a real topic,
  which is a data-entry step, not a code gap — see §1 Format 3).
- `scripts/generate-conversation-video.js` + sample script — **built AND
  actually run end-to-end**, real ElevenLabs audio (both voices, confirmed
  `provider=elevenlabs` on every turn), real ffmpeg render, real 60s
  1080x1920 mp4 sitting in `Media/conversations/`, verified via `ffprobe`.
  Not posted, not in `video_library`.

**Plan-only (documented above, needs either Heath's call or more build
time):** contract-trivia verification workflow (§3), `content_calendar`
row-seeding for formats 3/4/5/7, the `produce-skits.py` CTA staleness fix
(§5).
