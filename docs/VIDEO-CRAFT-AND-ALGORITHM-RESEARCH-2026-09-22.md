# Video Craft, Script Craft, and Algorithm Mechanics — Research
**Written 2026-09-22.** Companion to `docs/NICHE-VIDEO-RESEARCH-2026-09-22.md` (who is winning in
the niche). This document is about **how the work is actually made** — cut craft, sound, colour,
captions, script, delivery — and what our own engine can and cannot do against that standard.

**Heath's goal, verbatim:** *"I want to receive a script from you and I video myself doing it and
then give you the raw video and have you edit it to look and sound professionally produced."*

---

## 0. How to read this document

Short-form editing craft has almost no peer-reviewed literature and the platforms publish very
little. A great deal of what circulates as "the rule" is a tool vendor's benchmark with a number
attached. Every claim below carries a confidence tag:

| Tag | Meaning |
|---|---|
| **[ON RECORD]** | Stated by the platform itself, or a primary craft/standards source |
| **[ATTESTED]** | Credible trade reporting or a source with named methodology |
| **[CONVENTION]** | Repeated across working practitioners; real practice, no study behind it |
| **[FOLKLORE]** | Widely repeated, no traceable source. Numbers here are made up somewhere upstream |
| **[MEASURED HERE]** | I measured it on our own files/binaries on 2026-09-22 |

**A warning about our existing docs.** `docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md` §1.1 — which our
quality gate's thresholds partly derive from — cites `teleprompter.com`, `faceless.so`,
`terramarketgroup.com` and `truefuturemedia.com`. Those are exactly the SEO-tier sources this
research was asked to reject. Specifically, the playbook's "TikTok completion bar is ~70%", "layered
hooks hit 90% retention vs 60%", and "IG weighs engagement in the first 0.5 seconds" claims are
**[FOLKLORE]** — I could not trace any of them to a platform statement or a study. They may be
directionally right. They should not be treated as calibration data, and §3 below gives what the
platforms actually say instead.

---

## 1. The craft of professional editing

### 1.1 Cut rhythm — what is real and what is not

**The "cut every 2-3 seconds" rule is [FOLKLORE] with a real phenomenon underneath it.**

- There *is* a genuine perceptual basis near 2-3 seconds: research on temporal integration windows
  for naturalistic visual sequences finds motion-coherence detection asymptotes around 2-3s, and
  that window recurs across speech-utterance length and motor-action segmentation — a candidate
  "subjective present." [ON RECORD]
  [PMC — Temporal Integration Windows](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4092072/)
- Its application as a short-form editing cadence is **not** evidenced anywhere. Every source
  asserting it (CutScore, OpusClip, Vidpros) presents it as their own benchmark. CutScore itself
  hedges that shot-length ranges are *"starting points, not laws... an average across a video, not a
  target for every single shot."* [ATTESTED]
  [CutScore](https://cutscore.io/blog/how-fast-should-i-cut-my-video)
- Contradictory unsourced numbers circulate freely in the same space: "one cut every 2-4s for
  Shorts" vs "rapid cuts every 0.5-1s gives 3.3x completion" vs "mobile attention span is now 1.7
  seconds." All three are **[FOLKLORE]**. Do not calibrate on any of them.
- Real, documented data does exist for feature film average shot length (ASL): 8-11s in the 1930s
  down to 4.3-4.9s today; 1980s MTV-influenced films like *Top Gun* hit 3-4s. [ON RECORD]
  [Post-classical editing](https://en.wikipedia.org/wiki/Post-classical_editing)
- Vendor-circulated format ranges, useful only as a rough shape: talking-head/explainer 4-8s,
  vlog 2-5s, fast commentary 1.5-3s, TikTok/Reels 1-2s. [FOLKLORE]

**What is solid is what editors cut ON, not how often.** [CONVENTION] Practitioner tooling and
tutorials converge: cut on silence, filler words, false starts and dead air — at *speech* boundaries,
not on a metronome. FireCut's automated jump-cut explicitly uses **voice detection rather than a
volume threshold**, specifically so whispers and end-of-sentence breaths survive and only true dead
air is removed. That implies the working convention is: **the trailing breath is usually worth
keeping; the gap after it is not.**
[AutoCut/4K Shooters](https://www.autocut.com/en/blogs/tutorial-jump-cuts-premiere-pro/) ·
[FireCut](https://learn.firecut.ai/features/remove-silences/j-cuts)

**Jump cut vs. cutaway — the distinction that matters for us.** [ON RECORD]
- A **jump cut** removes a slice of the *same continuous shot*. The small visible jump is the point;
  it deliberately violates the 30-degree rule.
  [Jump cut](https://en.wikipedia.org/wiki/Jump_cut)
- A **cutaway** replaces the picture entirely while audio continues. Adobe's own craft guide states
  cutaways/b-roll and sound bridges are the standard technique for *smoothing* a jump cut that would
  otherwise be jarring.
  [Adobe — Jump Cut](https://www.adobe.com/creativecloud/video/post-production/cuts-in-film/jump-cut.html)

**Practical rule I'd actually adopt, stated as taste not fact:** cut on speech boundaries; never on a
clock. Vary the interval. Give every removed pause *some* visual justification — a punch-in, a
cutaway, or a caption change landing on the same frame — because an unmotivated jump cut with
nothing else changing is one of the named amateur tells (§1.8).

**ffmpeg:** yes, fully. We already do the detection half correctly (word-timestamp-driven cutlist).
What we do not do is the *visual* half — see §4.1.

### 1.2 J-cuts and L-cuts

**Definition.** J-cut = the incoming shot's audio starts before its picture. L-cut = the outgoing
shot's audio continues after its picture has gone. [ON RECORD]
[FireCut — split edits](https://firecut.ai/blog/mastering-the-split-edit-how-j-cuts-and-l-cuts-work/)

**Why it makes a cut invisible — the mechanism, not the vibe.** [CONVENTION, multiple sources agree]
Audio and picture changing on the same frame is *what reads as an edit*. Offset them and the eye and
the ear are never interrupted at the same instant, so no single moment is identifiable as "the cut."
It also mimics real perception, where you frequently hear something before you look at it.
[Soundstripe](https://www.soundstripe.com/blogs/a-video-editors-guide-to-j-cuts-and-l-cuts) ·
[Miracamp](https://www.miracamp.com/learn/video-editing/j-cuts-and-l-cuts)

**The numbers are thin and I will not pretend otherwise.** The only concrete figure I found is
FireCut's automation default of **1-10 frames** of offset, with 4 frames described as "subtle but
very powerful." [ATTESTED] Soundstripe gives no frame count at all, only "a few frames to a few
seconds," and recommends testing by ear. **The principle is solid; the exact offset is taste.**
At 30fps, 4-10 frames = **133-333 ms**. That is my starting range, presented as a starting range.

**For talking-head + b-roll specifically:** the L-cut is the founder-content workhorse — the picture
cuts to the product/screen/document while the speaker's voice runs on underneath. That is exactly
the shape our b-roll feature should have and currently does not (§4.2).

**ffmpeg: YES — verified working 2026-09-22.** [MEASURED HERE] Trim video and audio to *different*
boundaries and concat the two streams independently, then `acrossfade` the audio seam:

```bash
ffmpeg -i base.mp4 -filter_complex \
"[0:v]trim=0:2,setpts=PTS-STARTPTS[v0];[0:v]trim=3:6,setpts=PTS-STARTPTS[v1];\
 [0:a]atrim=0:2.25,asetpts=PTS-STARTPTS[a0];[0:a]atrim=3.25:6,asetpts=PTS-STARTPTS[a1];\
 [v0][v1]concat=n=2:v=1:a=0[v];[a0][a1]acrossfade=d=0.08:c1=tri:c2=tri[a]" \
-map "[v]" -map "[a]" out.mp4
```
The audio here leads the picture by 250 ms with an 80 ms crossfade at the seam. This ran clean on our
WSL ffmpeg 7.0.2. It is a modest rewrite of `render-cutlist.js`, not a new subsystem.

### 1.3 Punch-in discipline

**There is no sourced percentage threshold.** I looked hard. The "must change scale by at least
X% or it reads as a mistake" rule is **[FOLKLORE]** — nobody quantifies it, despite it being one of
the most-asked questions in the space.

What *is* real is the analogue it is derived from: the **30-degree rule** — successive shots of the
same subject should differ by at least 30° of camera angle or the cut reads as an unmotivated jump.
[ON RECORD] [30-degree rule](https://en.wikipedia.org/wiki/30-degree_rule)

For a locked-off single-camera talking head you cannot move 30°, so scale change substitutes as the
"this was intentional" signal. That reasoning is implied across practitioner sources but never
stated with a number. **My working number, offered as taste:** ≥1.15x between consecutive shot
sizes to read as deliberate, ≤1.35x to avoid reading as a jolt. Our reviewer already flags ≥1.45x as
a jarring jump (`review.js` `T.scaleJump = 1.45`), which is consistent with that band from the
upper side.

**When to punch vs. when to hard-cut vs. when to hold.** [CONVENTION] The only well-attested
guidance is *motivation*: punch-ins should land on script beats — the number, the mistake, the
punchline — "not just randomly placed," and a zoom cadence that suits comedy would be jarring in a
tutorial. [TikTok @katiesteckly](https://www.tiktok.com/@katiesteckly/video/7354004424777288965)

**How many in 30s before it's gimmicky:** not quantified by any source I found. Treat any specific
count you see elsewhere as invented. What is named as an amateur tell is *uniform* zooming — zoom on
every line — which is the failure mode the motivation rule warns against (§1.8).

**Technical constraint that is real:** punch-in headroom is bounded by source resolution, not taste.
Shooting UHD and delivering 1080 gives real room to punch digitally without softening. [CONVENTION]
Our `edit.js` already scales the intermediate to 2880px long edge for exactly this reason — that
part is right.

**ffmpeg: YES, two ways — both verified 2026-09-22.** [MEASURED HERE]
- **Hard punch-in** (instant, on a cut) — crop then rescale on one segment of a concat:
  `[0:v]trim=2:4,setpts=PTS-STARTPTS,crop=iw/1.18:ih/1.18,scale=1080:1920,setsar=1[b]`
- **Slow push** (a drift over a held line) — `zoompan`:
  `zoompan=z='min(1.0+0.0012*on,1.12)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=30`

The Python compositor on `main` already uses `zoompan` for Ken Burns on listing reels, so the
technique is proven in our tree; it has simply never been applied to talking-head footage.

### 1.4 B-roll timing

**This is the weakest-sourced topic in the whole brief. I am flagging it rather than inventing
numbers.**

- The convention "b-roll should start *slightly before* the spoken reference" is asserted
  everywhere and **quantified nowhere**. [FOLKLORE as to the number, CONVENTION as to direction]
- The "15-second b-roll rule" you will find is about *capture* (shoot ≥15s of each take for handles),
  not edit timing. [ATTESTED]
  [Stark Insider](https://www.starkinsider.com/2015/04/video-tips-15-second-b-roll-rule.html)
- The one genuinely craft-level source, Inside The Edit, gives a model rather than a duration:
  b-roll works on a **horizontal** axis (progression of action) and a **vertical** axis (emotional
  alignment — the shot lands "right on top of the exact words that need emphasis"). Their
  instruction is to find *anchor points* in the dialogue and align to them, not to apply a fixed
  lead time. [ON RECORD]
  [Inside The Edit](https://www.insidetheedit.com/blog/b-roll-editing-structure)
- **Setup vs. punchline:** I could not find any video-editing source addressing this. The adjacent
  comedy-editing craft (protect the punchline's timing, trim the setup ruthlessly; stay on the
  joke-teller through the punch) suggests b-roll under *setup/explanation* is safe and b-roll under
  the *reveal* risks killing it, because you lose the speaker's face at the beat the audience needs
  to react to. **That is my inference, clearly labelled — not a sourced rule.**

**What I would implement given how thin this is:** lead the b-roll in by roughly one J-cut offset
(~150-300 ms) ahead of the anchor word, hold 1.5-3s, and return to face *before* the payoff line.
Every one of those numbers is taste; log them as an experiment, not a standard, and let the
performance data settle it.

**ffmpeg: YES, but our current implementation is wrong** — see §4.2. B-roll must be an **overlay**
over the continuing voice track (an L-cut), not a splice that replaces the audio.

### 1.5 Sound design — the largest "produced vs. raw" lever

This is the best-sourced section, and it is where the most improvement per hour of work sits.

**Room tone.** [ON RECORD] Room tone is the ambient signature of a location — HVAC, traffic, room
resonance — present even when nobody speaks. Cutting to true digital silence is *not* what the
listener has been hearing, and human hearing is acutely sensitive to that abrupt spectral change, so
a hard cut to zero reads as *"something was removed"* even to non-technical listeners. Filling cut
gaps with matched room tone is standard practice specifically to prevent this.
[SoundGirls](https://soundgirls.org/the-sound-of-silence/) ·
[ProVideo Coalition](https://www.provideocoalition.com/room-tone-28-weeks-post-audio-week-2/)

**Whooshes and risers.** I could not source a direct answer for founder/talking-head content
specifically — flagging it as a real gap rather than guessing. The surrounding craft material
repeatedly names heavy transition SFX as an over-editing "LOOK AT ME" tell (§1.8), which suggests
restraint, but **that is inference.** For Dossie specifically, §4 of the Creative Director Standard
already forbids "cheesy transitions," so the house rule settles it regardless of the research.

**Music level and ducking — real numbers, multiply sourced.** [ATTESTED]
| Parameter | Value |
|---|---|
| Sidechain gain reduction | **3-5 dB** (>5 dB is audibly noticeable, <3 dB is ineffective) |
| Ducking ratio | **3:1 to 4:1** |
| Attack / release | **~10-15 ms / ~70-80 ms** |
| Static music level under speech | **~18 dB below** speech as a starting point |
| W3C accessibility minimum | non-speech audio **≥20 dB below** foreground speech |
| BBC practice | a further **4 dB** cut after the initial mix, as safety margin |
| Dense explanatory content | music as low as **−22 dB** under narration |

[Gearspace](https://gearspace.com/threads/voiceover-dealing-with-ambient-noise-room-sound-when-cutting-editing-silence.1314489/) ·
[PureAudioInsight](https://pureaudioinsight.com/blogs/content-production/background-music-volume-how-loud-should-it-be)

Note the correction to a common assumption: this convention is expressed as **relative dB offset
from the voice track**, not as an absolute LUFS figure for the music stem. Our engine's
`musicUnderVoiceDb: 14` reviewer threshold is *more permissive* than every source here (14 dB vs a
18-20 dB convention) — i.e. our gate would pass music that the accessibility guidance calls too
loud.

**Loudness targets — mostly unofficial, and this needs saying plainly.** [ON RECORD + ATTESTED]
- **YouTube is the only platform with a published number: −14 LUFS integrated**, and its
  normalisation is **turn-down only** — it will not raise quiet audio.
  [Dan Murtagh](https://danmurtagh.com/lufs-loudness-standards)
- **TikTok, Instagram/Reels and Facebook have never published a LUFS target.** Direct quote from a
  specialist source: *"TikTok has never published an official LUFS target or documented their
  normalisation behaviour... Every number you see online for these platforms is an educated guess."*
  [forasoft](https://www.forasoft.com/learn/audio-for-video/articles-audio/lufs-targets-per-platform-2026)
- Convergent practical recommendation where no official target exists: master to **−14 LUFS
  integrated, −1 dBTP**.

We currently render at **−16 LUFS / −1.5 dBTP** (`edit.js` default `loudnessTarget`). Measured on
`dossie_trial_06.mp4`: **−16.2 LUFS integrated, −1.1 dBFS true peak, LRA 3.3 LU** [MEASURED HERE].
That is ~2 LU quieter than a YouTube-aligned master, which on a turn-down-only platform is simply
2 LU of lost perceived presence for no benefit. The LRA of 3.3 LU is also very flat — a monologue
will naturally be low-LRA, but 3.3 is squashed enough to be worth listening to critically.

**Speech processing chain — two independent sources, broadly consistent.** [ATTESTED]

Order (both sources agree order matters more than exact values, and both put de-essing **after**
compression because compression raises sibilance):

1. **High-pass** ~80 Hz
2. **Noise reduction** (broadband)
3. **Subtractive EQ** — cut mud **200-400 Hz** by 2-4 dB; address nasal honk **800 Hz-1 kHz**
4. **Compression** — **3:1 to 4:1**, threshold just under average speech, **attack ~10-30 ms**,
   **release ~40-200 ms**, aiming for **2-4 dB** of gain reduction
5. **De-esser**
6. **Additive EQ** — presence **3-5 kHz**, air shelf **10 kHz+**
7. **Limiter** — ceiling **−1 to −0.3 dBFS**, 1-2 dB of limiting
8. **Loudness normalise**

[rysupaudio — vocal chain order](https://rysupaudio.com/blogs/news/best-vocal-chain-order)

**Phone mic in a hard room — what is and is not salvageable.** I could not source this directly;
the reasoning below is inference from the chain above and is labelled as such. EQ, compression,
de-essing and broadband noise reduction fix tonal balance, sibilance and hiss. **None of them touch
room reflections baked into the capture** — reverb is a reflection-timing/energy problem, not a
spectral or dynamics one. Dedicated de-reverb exists but artifacts audibly. Practically: our
`deroom` chain (−4 dB at 330 Hz, +3 dB at 3.2 kHz, a gate on the tails) measurably reduced the
200-500 Hz vs 1-4 kHz box ratio from +4.9 dB to +2.0 dB between trial 01 and 02 — that is real and
it helps, but it is cosmetic relative to not recording in a hard room. **The fix is at the
recording stage** (§5.3).

**ffmpeg verdict — everything in this section is available and verified [MEASURED HERE]:**

| Technique | Filter | WSL 7.0.2 | Win 9.0 |
|---|---|---|---|
| Sidechain ducking | `sidechaincompress` | yes | yes |
| Compression | `acompressor` | yes | yes |
| De-essing | `deesser` | yes | yes |
| Limiting | `alimiter` | yes | yes |
| High-pass / bell EQ | `highpass`, `equalizer` | yes | yes |
| Noise reduction | `arnndn` (RNNoise), `anlmdn`, `afftdn` | yes | yes |
| Music fades | `afade`, `acrossfade` | yes | yes |
| Loudness | `loudnorm`, `ebur128` | yes | yes |
| Room tone under cuts | `amix`/`amerge` with a looped tone bed | yes | yes |

Verified working ducking + full voice chain, run clean on WSL 7.0.2:
```bash
# ducking: voice sidechains the music
[0:a]aformat=channel_layouts=stereo,asplit=2[sc][mix];
[1:a]volume=0.5[m];
[m][sc]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300:makeup=1[duck];
[mix][duck]amix=inputs=2:duration=first:normalize=0[a]

# voice chain
highpass=f=85,deesser=i=0.4:m=0.5:f=0.5,
acompressor=threshold=-20dB:ratio=3:attack=8:release=150:makeup=2,
equalizer=f=3000:t=q:w=1.2:g=2.5,alimiter=limit=0.891,
loudnorm=I=-14:TP=-1.0:LRA=9
```
(`ratio=8` on the sidechain is the *compressor* ratio; tune `threshold`/`makeup` so measured gain
reduction on the bed lands in the 3-5 dB window the sources name.)

**Room tone specifically:** ffmpeg has no "room tone" filter, but the implementation is trivial —
extract 1-2s of the quietest inter-word gap from the raw take before cutting, loop it with
`aloop`, and `amix` it under the whole cut programme at ~−45 to −50 dBFS. This is the single
cheapest change that moves an edit from "raw" to "produced."

### 1.6 Colour

The published numbers here are thinner than I expected; what follows is what I could actually
source.

- **Skin tone placement** is checked on the vectorscope's skin-tone line — all skin tones, any
  ethnicity, should sit on or near it; off-line means white balance/tint is wrong. [CONVENTION]
- One concrete waveform target found: **skin tones around 60-70 IRE**. [CONVENTION]
- Repeated three-point structure (not a universal LUT, but a consistent pattern): **shadows cooled
  slightly toward blue/cyan, midtones warmed toward orange/amber, highlights bright and neutral** —
  a mild teal-orange structure without going stylized. [CONVENTION]
- Governing principle stated by every colour source: **"if your viewer notices the grade, it's too
  heavy."** Light grades are explicitly recommended over creative looks for talking-head/interview
  content. [CONVENTION]
- **No source gave a numeric saturation percentage or a contrast-curve shape.** Any specific S-curve
  steepness or saturation % you see elsewhere is unsourced. I am not going to invent one.

**ffmpeg: YES — verified working 2026-09-22 [MEASURED HERE].** A defensible "light grade" starting
point, deliberately conservative:
```bash
-vf "curves=all='0/0.02 0.25/0.22 0.5/0.5 0.75/0.78 1/0.98',\
eq=contrast=1.06:saturation=1.05,\
huesaturation=intensity=0.1,\
unsharp=5:5:0.4,\
vignette=a=PI/6"
```
That is a gentle S-curve (lifted toe, rolled shoulder), +6% contrast, +5% saturation, a touch of
sharpening and a soft vignette. `colorbalance` is available for the shadow-cool/midtone-warm split;
`lut3d` is available if we ever want to author a LUT properly. **Skin-tone protection is the one
thing ffmpeg cannot do well** — there is no qualifier/secondary, so any saturation push is global.
That argues for keeping saturation under ~+8% and doing white balance correctly instead.

**Right now our engine applies no colour operation at all.** Zero. See §4.5.

### 1.7 Captions as motion design

**Sizing at 1080×1920** [ATTESTED, vendor-tested]:

| Use | Size | % of frame height |
|---|---|---|
| Minimum readable | 48-55 px | 2.5-2.9% |
| Standard | 60-75 px | 3.1-3.9% |
| Bold / high-energy | 75-95 px | — |
| Practical max | ~100 px | — |

Font weight matters independently of size: **bold (700-900) reportedly scores 31% better on mobile
readability than medium weight at the same size** — that specific 31% is a vendor claim, treat as
**[FOLKLORE]**; the direction (go bolder) is well attested. Recommended pairings: semibold 600 at
65-70px for "polished," bold 700-900 at 70-80px for high-energy.
[BlitzCut](https://blitzcutai.com/blog/best-caption-size-instagram-reels-2026)

**Words on screen** [ATTESTED, same source]: word-by-word/karaoke 1-3 words on one line at 65-80px;
short phrase 3-8 words (one line at 65px or two at 75px); full sentence 8-15 words, max two lines at
60-65px. **More than two lines at any size crowds the safe zone.**

**Safe zones — two credible sources give different numbers, so here are both.**
- TikTok, px version: keep key content within **108 px top / 320 px bottom / 60 px left / 120 px
  right**. [ATTESTED]
- TikTok, % version: **top 10% (108px), bottom 20% (384px)**, avoid the right edge (engagement icon
  rail), safe area = central 80-90%. [ATTESTED]
- **Instagram/Facebook Reels: top 14%, bottom 35%, sides 6%** — leaving a central **1010×1280 px**
  safe core on a 1080×1920 frame. These figures originate in Meta's own ad-placement guidance.
  [ON RECORD via](https://houseofmarketers.com/guide-to-safe-zones-tiktok-facebook-instagram-stories-reels/)
- YouTube Shorts' UI covers roughly the bottom 320px; Instagram's covers roughly the bottom 500px.

**The load-bearing consequence for us:** Instagram's bottom-35% exclusion means the caption baseline
must sit **at least 672 px above the bottom edge** on a 1920-tall frame. Our `captionMarginV` is
**240** (brief) / **220** (default). Margins in ASS are measured from the frame edge, so our captions
sit roughly **430 px inside Instagram's UI exclusion zone.** That is a concrete, fixable defect
(§4.6).

**Animation vocabulary** [CONVENTION]: background block behind the active word; bounce (vertical
jump — playful, TikTok-coded); colour change on the active word; scale on the active word (pairs
best with a bright highlight colour). Word-level timestamps from Whisper-class transcription are
accurate to roughly **50-100 ms**, which is the practical floor for karaoke sync.

**Should captions move position through the video?** No source addressed this. Open question — I am
not going to assert either way.

**ffmpeg: YES via libass, verified 2026-09-22 [MEASURED HERE].** ASS override tags do real motion
design; neither Premiere nor After Effects is needed:
```
# pop-scale in: 88% → 104% over 90ms, settle to 100% over the next 60ms
{\fscx88\fscy88\t(0,90,\fscx104\fscy104)\t(90,150,\fscx100\fscy100)}THREE DEADLINES

# karaoke: per-word highlight, \k units are CENTISECONDS
{\k20}ONE {\k25}TRANSACTION {\k30}AND {\k35}FOURTEEN {\k40}EMAILS
```
Both rendered clean through `-vf ass=`. Note the format gotcha that will bite whoever implements it:
**`\k` karaoke timing is in centiseconds while `\t` animation timing is in milliseconds.** Also
available: `\fad()` for fades, `\move()` for position moves, `\pos()` for per-line placement,
`\c&H..&` for per-word colour, `\bord`/`\shad` for stroke and drop shadow.

We also have `drawtext` on the **Windows** ffmpeg 9.0 build (not on WSL 7.0.2) if we ever need
frame-accurate procedural text, plus `libharfbuzz` for proper complex text shaping in libass.

### 1.8 What makes an edit read as AMATEUR

Consolidated from the craft sources. Avoiding these is genuinely half the job.

**Structural / pacing**
- Doing the fun stuff (effects, SFX, graphics) before the story is locked — polished but hollow.
  [Storyblocks](https://www.storyblocks.com/resources/blog/editing-mistakes-beginners-make-with-video)
- Not knowing when to stop — stacking techniques until it reads as "LOOK AT ME."
- Keeping footage because it exists or you're attached to it, not because it earns its place.
- Pacing mismatched to the content — a comedy cadence on a tutorial.
- A weak or slow opening; long fade-ins.
- **Unmotivated cuts** — shot-to-shot with no matched action and no beat to land on.
  [MediaÀLaCarte](https://www.mediaalacarte.com/post/mistakes-that-make-your-reels-look-amateur-and-how-to-fix-them)

**Audio — the most commonly neglected**
- Under-prioritising audio at all. *"Poor audio can kill a video in seconds."*
- **Music overpowering speech** (named independently by two sources).
- **Hard cuts to true silence with no room tone.**
- Background noise, uneven volume, music misaligned to the edit.

**Captions / text**
- Insufficient contrast — white text with no outline or shadow on a light background.
- **Default / novelty fonts.** (We currently ship **Arial**. See §4.6.)
- Sizes too small for mobile.
- Inconsistent font, colour or placement within one video.
- Too many words on screen at once.
- **Captions colliding with platform UI** — the bottom-third default is covered on every platform.

**Visual / technical**
- Wrong aspect ratio, **letterboxed horizontal footage in a vertical frame**. (We shipped exactly
  this to Facebook on 2026-09-15 — two demos at 1920×1080 rendered ~80% black. Audit §10.5.)
- Inconsistent grading between clips in the same piece.
- Overuse of filters instead of one consistent look.
- **Whip-pans and transition effects, unmotivated or overused.** The technique is legitimate; the
  tell is frequency and sloppiness.
  [PremiumBeat](https://www.premiumbeat.com/blog/3-effects-whip-pan-transition/)
- **Zooming on every line** — the uniform-cadence failure mode the motivation rule in §1.3 warns
  against.
- No fresh-eyes review before publishing.

---

## 2. Script craft for camera

### 2.1 Writing for the ear

[ON RECORD, broadcast handbooks]
- **Sentence length: 20-25 words maximum**, leads tighter. The practical test taught in broadcast
  courses: read it aloud — if you run out of breath before the period, it's too long.
- **One thought per sentence.** Simple subject-verb-object. Short declaratives.
- **Spell numbers out as words.** AP broadcast style differs from AP print style specifically on this,
  because the copy exists to be spoken.
  [Broadcast Writing — Pressbooks/UArk](https://uark.pressbooks.pub/journalismgsp/chapter/broadcast/)
- **Readability target: Flesch-Kincaid grade 6-8** for general-audience spoken material; news
  writing broadly lands grade 7-10, Flesch Reading Ease 60-70. [ATTESTED — note this is a general
  spoken-writing convergence, *not* a published broadcast-industry standard]
  [Wylie Communications](https://www.wyliecomm.com/2021/11/measure-reading-levels-with-readability-indexes/)

**Concretely, for a Dossie script:** kill every sentence over 20 words, delete subordinate clauses
and semicolon lists, convert numerals to words, and replace every "which" clause with a second short
sentence.

### 2.2 Hooks that survive being read aloud

- First line should land inside **2-3 seconds**, roughly **10-14 words**; contrarian hooks work best
  under 10-12. [ATTESTED]
- The three formulas most consistently named: **contrarian claim**, **mistake warning** (name the
  exact mistake the viewer is making right now), **list tease**. [ATTESTED]
  [Vexub](https://vexub.com/blog/viral-short-form-video-hooks)
- **Specific numbers beat round numbers** — $3,841 reads as credible, $4,000 reads as manufactured.
- **Why written hooks die on delivery:** they front-load a qualifier or subordinate clause before the
  payoff. Fix is the same front-load-the-verb rule — the claim, number or mistake belongs in words
  1-3, not after a dependent clause.

### 2.3 Formatting a script for performance

[ATTESTED, converging across teleprompter guides]
- **8-12 words per line**, broken at thought/breath boundaries, never mid-clause.
- Idea break every 1-2 sentences so the reader holds their place.
- **Narrow the text column.** This is not just readability — it directly reduces lateral eye travel,
  which is the visible tell.
- Emphasis: bold or CAPS for stressed words; underline for inflection change.
- Pause: `...` for a breath, `(PAUSE)` for a 2-3 second beat before a landing thought.
- Phonetic spellouts in caps/brackets for names and hard words.
- **Speaking pace 125-190 wpm** across sources — treat as directional, the sources disagree.
  [Teleprompter.com](https://www.teleprompter.com/blog/how-to-write-a-script-for-a-teleprompter) ·
  [Beverly Boy](https://beverlyboy.com/filmmaking/why-use-script-line-breaks-for-teleprompting/)

### 2.4 The single most load-bearing finding: don't script the middle

A direct practitioner comparison states it plainly: verbatim prompter readers *"deliver content in a
flatter, more monotone way than when they speak freely... your pauses land between sentences instead
of between thoughts,"* whereas with bullets *"your voice has more range, you emphasize words
differently, pause where it feels natural, and make eye contact with the lens instead of tracking
text."* [ATTESTED]
[BirdCue — Teleprompter vs. Bullet Points](https://birdcue.com/blog/teleprompter-vs-bullet-points)

**The convergent middle path experienced creators use: script the hook and the CTA word-perfect;
bullet the body.** That is a direct answer to Heath's stated workflow, and it is a *modification* of
it, not a rejection: I still write the script, he still gets a script, but the middle section is
delivered as tracked bullets rather than read.

**The stronger alternative — interview yourself.** Write 3-5 open-ended questions, record himself
answering them conversationally with a clean pause between topics, then edit the best answers into a
monologue with the questions never shown or heard. There is no script to read, so the reading problem
disappears entirely. [ATTESTED]
[Paula Rizzo](https://paularizzo.com/2025/05/author-hack-interview-yourself-via-video/)

For a 40-something REALTOR who is not a performer, **this is probably the highest-leverage single
change in this entire document**, and it costs nothing to try.

### 2.5 Teleprompter technique, if we keep the prompter

- **The 15-degree rule** [CONVENTION, trade not peer-reviewed]: keep the prompter within ~15° of the
  lens axis. Beyond that, viewers register a clear look-away.
  [Tulip Films](https://www.tulipfilms.ch/en/post/teleprompter-interview)
- **Distance: 9-12 feet** presenter-to-lens is the industry-cited standard. [CONVENTION]
  [StudioKitGuide](https://studiokitguide.com/teleprompter-eye-line-setup/)
- **The actual mechanism behind the distance rule:** the same physical eye movement is proportionally
  smaller — therefore less visible — in a wider composition. So distance *and* a longer focal length
  both shrink visible eye travel. [ATTESTED]
  [FluidPrompter](https://docs.fluidprompter.com/getting-started/reducing-eye-movement/)
- **Scroll speed:** fixed-speed scroll forces the speaker to race or lag the text, which is visible
  as tension. **Voice-activated scrolling** (PromptSmart's VoiceTrack, Teleprompter.com's app)
  follows speech and pauses when the speaker pauses. Presented as meaningfully better for natural
  pacing. [ATTESTED]
- **A working creator's actual rig** (Thomas Frank): Bluetooth page-turner/foot pedal instead of
  voice scroll (avoids recognition errors); longer lens, stands farther back; text column as narrow
  as possible; yellow text not the default blue; reads *peripherally* rather than line-by-line;
  gestures to mask reading; and **films one prompter take then re-films the same section from
  memory, using whichever is more natural.** [ATTESTED]
  [Thomas Frank](https://thomasjfrank.com/creator/working-with-a-teleprompter/)

### 2.6 Delivery fixes for a non-performer

[ATTESTED / CONVENTION across on-camera coaching sources]
- **Talk to one specific person**, not "the audience." Pick a real person and address them.
- **Stand, don't sit.** Changes breathing, posture and vocal energy.
- **Energy calibration.** The popular "120% feels like 100% on camera" is **[FOLKLORE]** as a
  number — sources disagree, one frames it as "Plus 10%," another as ~20% above natural. The
  *phenomenon* (2D capture flattens presence, so deliberate over-delivery reads as normal) is
  consistently taught. **Cite 10-20%, not 120%.**
- **Memorise the hook, outline the rest** — memorise landmarks, not words.
- **Record a deliberate throwaway first take** to burn off stiffness.
- **Record in 30-90 second chunks,** not one continuous take. Reduces pressure, creates natural edit
  points, lets him reset instead of restarting.
- **Warm-ups:** exaggerated facial movement to loosen the face; box breathing (in 4, hold 4, out 6).
- **Gesture deliberately** — it unlocks vocal variety. Don't sway or bounce.
  [BirdCue](https://birdcue.com/blog/read-script-on-camera-naturally) ·
  [Descript](https://www.descript.com/blog/article/how-to-read-a-script-like-a-pro-while-recording) ·
  [Moxie Institute](https://www.moxieinstitute.com/anxiousness-to-confidence-how-to-speak-on-camera/)

---

## 3. Algorithm mechanics, 2026

Confidence tagging matters more here than anywhere else, because this topic is 95% blogspam.

### 3.1 Instagram Reels

**The ranking signals, in Mosseri's own words** (Instagram video, 2025-01-22) [ON RECORD]:

> *"The top three signals that matter most for ranking are watch time, likes and sends. So when
> looking at your insights, pay close attention to average watch time, likes per reach, and sends per
> reach."*

And the split that matters most for us:

> *"Likes are slightly more important for connected content, and sends are slightly more important
> for unconnected content."*

[Social Media Today](https://www.socialmediatoday.com/news/instagram-shares-algorithm-insights-2025/738034/)

**Connected = your followers. Unconnected = recommendations, which is the only place a near-zero
follower account grows.** So for us, **sends per reach is the metric to optimise.** That means every
video should answer: *would an agent DM this to another agent?*

Two corrections to things widely repeated:
- Comments are **absent** from Mosseri's named top three. Whether they're deprioritised or simply
  weren't mentioned is not established. [ATTESTED at best]
- The "1 DM share = 15 likes" and "sends weigh 3-5x" figures are **[FOLKLORE]** — the verified quote
  says only *"slightly more important,"* with no ratio.
- Mosseri names **watch time**, not completion *rate*. No verified IG statement frames percentage-
  watched as the named metric.

**Original-content policy — this one has teeth** (Instagram creator blog, 2026-04-30) [ON RECORD]:
> *"75% of recommendations in the US now come from original posts."*
> *"accounts that primarily post unoriginal content... will no longer be shown in places where we
> recommend content."*

Content re-uploaded with only *"a border, watermark, subtitles, or a credit in the captions"* added
does **not** count as original. Recommendation surfaces only — it does not affect what existing
followers see. Requalification is on a rolling 30-day window.
[creators.instagram.com](https://creators.instagram.com/blog/rewarding-original-creators-on-instagram/)

**Trial Reels — the one purpose-built cold-start lever** [ON RECORD]. Shown only to non-followers,
not added to your grid, not shown to followers. Mosseri, on the mechanism: Trial Reels *"skip the
entire connected ranking system and instead go directly to unconnected recommendations."* And his
warning, which is important: *"It's going to get less reach, almost always. So what you need to do
is compare trial reels to other trials."* Instagram's own reported figure is an 80% increase in
non-follower Reels reach.
[Social Media Today](https://www.socialmediatoday.com/news/instagram-allows-creators-to-schedule-trial-reels/816549/)

**For an account with near-zero followers, this is structurally the right tool** — it routes straight
into the pipeline that would otherwise be gated behind follower engagement we don't have. That is an
inference from Mosseri's framing, not a platform recommendation for small accounts.

**Gap:** I could not find any primary IG statement giving a percentage of reach that comes from
non-followers for new accounts. Any such number is **[FOLKLORE]**.

### 3.2 TikTok

**Official For You factors** (TikTok Newsroom, still the standing explainer) [ON RECORD]:
user interactions (likes, shares, follows, comments, creations, watches, searches) · video
information (captions, sounds, hashtags) · device/account settings (explicitly weighted **lower**).
[newsroom.tiktok.com](https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you)

**The clearest public weighting statement they have made** [ON RECORD]:
> *"A strong indicator of interest, such as whether a user finishes watching a longer video from
> beginning to end, would receive greater weight than a weak indicator, such as whether the video's
> viewer and creator are both in the same country."*

**Follower count** [ON RECORD]:
> *"neither follower count nor whether the account has had previous high-performing videos are
> direct factors in the recommendation system."*

TikTok's own caveat follows immediately: high-follower accounts still get more baseline reach from
their follower base — a structural effect, not the ranking system weighting followers.

**Contradiction worth flagging.** The widely repeated 2026 claim that TikTok now weights raw watch
time *over* completion directly contradicts the statement above, and I could not find a primary
2025/2026 TikTok source supporting it. **Do not treat "watch time now beats completion" as
confirmed.** [FOLKLORE]

**The "test batch" mechanic** — that every new video gets a small free-view batch before the system
decides to push it — is **[FOLKLORE]**. Widely believed, not in any TikTok statement I could reach.

**AI disclosure** (TikTok Newsroom, 2023-09-19) [ON RECORD]: realistic AI-generated image/audio/video
must be labelled. **TikTok's announcement is silent on whether labelled AI content is distributed
differently.** That silence is not evidence either way.
[newsroom.tiktok.com](https://newsroom.tiktok.com/en-us/new-labels-for-disclosing-ai-generated-content)

### 3.3 YouTube Shorts

**View counting changed 2025-03-31** [ON RECORD]:
> *"Views will count the number of times a Short starts to play or replay, with no minimum watch time
> requirement."*

The older, stricter metric was renamed **"Engaged views"** and still tracks continued watching. So
the headline view number on Shorts is now nearly meaningless as a quality signal; **engaged views is
the number to read.**
[support.google.com/youtube/answer/10059070](https://support.google.com/youtube/answer/10059070)

**"Viewed vs. Swiped Away"** is a real panel in YouTube Studio's Shorts analytics [ATTESTED], and
YouTube's general framing is that Shorts recommendation depends on whether people view or swipe away,
how long and how much they watch, likes, and post-watch survey feedback. **The specific numbers that
circulate — "under 30% swipe-away gets 4x the distribution of over 50%," attributed to a Tubular 2025
report — I could not verify.** [FOLKLORE until the report is located.]

**AI disclosure** [ON RECORD] — the clearest statement any platform has made on this:
> *"Disclosing AI content won't limit a video's audience or impact its eligibility to earn money."*

Non-disclosure can trigger a manually applied label or penalties.
[support.google.com/youtube/answer/14328491](https://support.google.com/youtube/answer/14328491)

This directly contradicts the claim in our own audit package §12.2 that labelled synthetic content is
"quietly deprioritised" — that claim was sourced to an industry-observation piece, and the one
platform that has spoken on the record says the opposite.

**Gaps:** no primary source located on subscriber count's role in Shorts ranking, on Shorts/long-form
audience separation, or on any 2025-26 Creator Insider statement. Anything attributed to Creator
Insider on Shorts ranking should be treated as unverified.

### 3.4 Cross-platform: what actually matters, and the cost of a weak first second

**What is genuinely known about relative weighting:**
- IG: watch time > likes ≈ sends, with sends skewing toward non-follower reach. [ON RECORD]
- TikTok: completion of a longer video is a "strong indicator," above weak signals. [ON RECORD]
- YouTube: viewed-vs-swiped, watch duration, likes, post-watch survey. [ATTESTED]

**What is NOT known, for any platform:** any numeric weighting of saves vs. comments vs.
follows-from-video vs. rewatches. Every "rewatches count 3x" or "a save is worth five likes" claim in
circulation is **[FOLKLORE]**.

**The real cost of a weak first 1-2 seconds.** I could not find a single platform-published dataset
quantifying this. What is structurally certain from the platforms' own named signals: a swipe in the
first moment forecloses *every* downstream signal — watch time, completion, sends, saves, follows —
so the opening is the highest-leverage lever by construction, not by measurement. **Treat "the first
two seconds matter most" as a sound inference from on-record signals, not as a cited statistic**, and
be suspicious of anyone quoting a percentage for it.

**Cross-posting.** No platform penalises cross-posting per se. What *is* documented is that
**Instagram penalises visible watermarks**, including another platform's, under the original-content
policy above. So a TikTok-watermarked file reposted to Reels is a real, documented penalty case. No
equivalent primary statement exists for TikTok or YouTube; the assumed symmetry is **[FOLKLORE]**.
Practical rule: render one clean master per platform from source, never re-download from a platform.

**AI-generated content down-ranking:** unverified everywhere. YouTube explicitly denies it for its
own platform; TikTok is silent; Instagram has said nothing I could find. [FOLKLORE]

### 3.5 What this means for us specifically

We are a near-zero-follower account in a niche. From on-record statements only:

1. **Optimise for sends, not likes.** That's IG's named lever for the unconnected reach that is our
   only growth path. Design each video around "would an agent forward this to another agent?"
2. **Use Trial Reels** as the default publishing mode for new formats, and benchmark trials against
   trials, not against normal Reels — Mosseri said explicitly the reach will be lower.
3. **Never ship a watermarked or re-downloaded file.** Render a clean master per platform.
4. **Completion is TikTok's one named strong signal.** That argues for *shorter*, not longer — cut to
   the shortest version that lands, which is also §12 of our own Creative Director Standard.
5. **Read engaged views on YouTube, not views.** The headline number changed meaning in March 2025.
6. **Disclose AI.** YouTube says on the record it costs nothing; TikTok requires it. Our audit's
   worry about a quiet reach penalty is unsupported.

---

## 4. What our engine actually lacks, ordered by impact

**Where the code lives.** The current engine is
`.claude/worktrees/video-engine-reviewer-0921/scripts/video-engine/` — `edit.js`, `cutlist.js`,
`captions.js`, `render-cutlist.js`, `face-track-crop.js`, `produce.js`, `review.js`, `review-lib/`.
**`produce.js` and `review.js` have zero commits on any branch** [MEASURED HERE]; the rest were
committed under `feat(video-engine)` commits that are not on the working branch. The
`build-shortform-video.py` compositor on `main` is a separate, older path used for screen-recording
formats.

### 4.1 — #1 — The editor cannot change the picture, and the reviewer already knows it

This is the finding that explains five rejected cuts.

**Measured on `dossie_trial_06.mp4`** [MEASURED HERE]: 35.7 seconds long, and scene-change analysis
finds exactly **two** real cuts — at **27.0s** and **29.7s**, both in the last quarter. Every other
frame-to-frame delta in the file scores below 0.24 (caption changes and natural motion). **The first
27 seconds is one unbroken shot at one fixed framing.**

That is not an editing style. That is a video with no edit in it. `face-track-crop.js` applies a
*single fixed* `zoom` (brief: 1.05) and smoothly pans it to follow the face. There is no second shot
size, no punch-in, no cutaway, nothing. Against §4 of the Creative Director Standard ("the screen
should not remain visually static for long periods") this fails by 27 seconds to 12.

**The structural part is worse than the symptom.** `review.js` detects this correctly — `T.longestStretchWarnSec = 7`, `T.longestStretchFailSec = 12` — and emits:

> *"Longest uncut stretch is Ns from Ms; add a purposeful punch-in or product cutaway inside it (§4)."*

…with a `null` brief patch, because **`edit.js` has no knob that can do it.** Nine of the reviewer's
28 fixes pass `null`. `produce.js` then collects them as *"notes with no editor knob"* and, when no
brief field changed, prints *"nothing left to change in the brief — stopping early"* and gives up.

**So the loop is: the reviewer correctly names the #1 defect, the editor structurally cannot fix it,
and the loop terminates having changed nothing.** Five rounds of that is five rejected cuts.

**Fix:** `cutlist.js` must emit a *shot plan*, not just keep-segments — a list of `{start, end,
shotSize}` where shot size alternates between wide (1.0-1.05) and punch (1.18-1.30), with changes
placed on sentence/beat boundaries. `render-cutlist.js` then applies a per-segment
`crop=iw/z:ih/z,scale=1080:1920` before concat. **Verified working** (§1.3). This is the single
highest-impact change in the document.

### 4.2 — #2 — B-roll cuts the voice off

`edit.js` step 8 splices b-roll in as a concat segment with `anullsrc` silent audio attached. **The
speech stops dead for the duration of the b-roll and resumes afterward.** That is the opposite of
every source in §1.2/§1.4 — b-roll in talking-head short-form is an **L-cut**: picture changes,
voice continues underneath.

It also means `brollInserts` is effectively unusable, which is why `briefs/dossie.json` has
`"brollInserts": []` and why there is no cutaway available to solve §4.1.

**Fix:** implement b-roll as a video-only overlay/replacement on a continuous audio bed — build the
full audio programme first, then swap picture segments against it. Trivially doable with the same
independent-a/v-trim structure verified in §1.2.

### 4.3 — #3 — Music is not ducked, despite the code saying it is

`edit.js` step 9 header says *"Music (ducked under voice)."* The actual filtergraph is:

```
[1:a]volume=${musicVolume}[music];[voice][music]amix=inputs=2:duration=first
```

That is a **static gain**, not ducking. There is no `sidechaincompress` anywhere in the engine. The
Python compositor on `main` has the same gap (static `loudnorm` on the bed, then `amix`) — though it
does at least fade the bed in and out, which `edit.js` does not: our music starts abruptly at t=0,
loops with `-stream_loop -1`, and stops dead at the end.

Related, from §1.5: the reviewer's `musicUnderVoiceDb: 14` threshold is more permissive than the
18-20 dB convention and the W3C's 20 dB accessibility minimum.

**Fix:** `sidechaincompress` keyed off the voice, tuned to 3-5 dB of gain reduction; `afade` in/out
on the bed; raise the reviewer threshold to 18 dB. All verified (§1.5).

### 4.4 — #4 — Every cut is a hard butt-splice with no room tone and no J/L offset

`render-cutlist.js` trims video and audio to **identical** boundaries and concats. Consequence:
- Every cut announces itself, because eye and ear are interrupted on the same frame (§1.2).
- Every removed pause leaves a seam against **true digital silence** — the exact thing §1.5's
  sources identify as reading "something was removed" even to non-technical listeners.
- No `acrossfade` at the seams, so clicks are possible at zero-crossing mismatches.

**Fix:** independent a/v trim boundaries (verified §1.2), 80 ms `acrossfade` at each audio seam, and
a room-tone bed extracted from the raw take's quietest gap mixed under the whole programme at
~−45 dBFS.

### 4.5 — #5 — No colour operation at all

There is no `eq`, `curves`, `colorbalance`, `huesaturation`, `unsharp` or `vignette` anywhere in
`edit.js`. The footage goes to air with whatever the phone's auto-exposure and auto-white-balance
produced. Every source in §1.6 treats a light grade as table stakes; it is also one of the named
amateur tells when absent or inconsistent (§1.8).

**Fix:** a fixed brand grade applied once in the final pass. Verified recipe in §1.6. Keep saturation
under +8% because ffmpeg has no skin-tone qualifier.

### 4.6 — #6 — Captions are a transcript in Arial, in Instagram's UI exclusion zone

`captions.js` produces:
- **Font: Arial.** A default font is on every amateur-tell list I found (§1.8).
- **No animation.** Static chunks that appear and disappear. No pop-scale, no karaoke, no per-word
  highlight — despite the fact that we *already have word-level timestamps* from the ElevenLabs
  scribe transcript and libass supports all of it (verified §1.7).
- **Emphasis from a hand-maintained word list** (`brief.emphasisWords`), colour-only. It emphasises
  the literal string "Dossie" every time it occurs rather than the word that carries the beat.
- **Fixed position** at `MarginV` 220-240 px from the bottom. Instagram's safe zone excludes the
  **bottom 35% = 672 px**. Our captions sit roughly **430 px inside Instagram's UI exclusion zone**
  on every Reel we have rendered.
- Chunking at "4 words OR 2.2s OR sentence end" produces uneven rhythm rather than beat-aligned
  phrases.

**Fix, in order:** raise `captionMarginV` to ≥700 for IG/FB (platform-conditional); replace Arial
with a bold brand face; add `\t` pop-scale and `\k` karaoke from the timestamps we already have;
derive emphasis from beat position rather than a keyword list.

### 4.7 — #7 — The quality gate measures absence of defects, and everyone already knows

`edit.js` step 10's gate is: duration > 3s, resolution == 1080×1920, an AAC track exists. That is the
exact failure Heath named when he wrote the Creative Director Standard — *"the gate measured absence
of defects. This document defines presence of quality."*

`review.js` **is** the real answer to this and it is genuinely good — 11 QC dimensions, calibrated
thresholds, face metrics, A/V sync measurement against the source, vision checks. The problem is
§4.1: it grades better than the editor can act. **The gap is not in the reviewer, it is in the
editor's vocabulary.**

### 4.8 — #8 — None of it is committed, and the loudness target is 2 LU low

- `produce.js` and `review.js` exist on disk in a worktree and **nowhere in git history.** A machine
  wipe or a stray worktree cleanup loses the entire reviewer. The audit already flagged "all engine
  code uncommitted" and this is still true on 2026-09-22.
- Loudness target `−16 LUFS` vs the `−14 LUFS` convergent recommendation. Measured −16.2 LUFS on
  trial 06 [MEASURED HERE]. On YouTube — the one platform with a published target, and it is
  turn-down-only — we are simply 2 LU quieter than we need to be, for nothing.
- **Voice chain is missing compression, de-essing and limiting entirely.** Current chain:
  `[offset] → arnndn → [deroom EQ + gate] → loudnorm`. Against the §1.5 reference chain, we have
  high-pass, noise reduction and subtractive EQ but no dynamics control at all. Measured LRA on trial
  06 is 3.3 LU, which is `loudnorm` doing the work a compressor should do, less well.

### 4.9 Two capabilities we have and are not using

[MEASURED HERE, 2026-09-22]

- **The Windows ffmpeg 9.0 build has a `whisper` filter** (gyan.dev full build, `--enable-whisper`).
  Local, free, word-level transcription — no ElevenLabs API call, no network dependency in the cut
  loop. Also `drawtext` (absent from WSL 7.0.2), `libharfbuzz` for proper text shaping,
  **QSV and NVENC hardware encoders** (`h264_qsv`, `h264_nvenc`, `scale_qsv`, `overlay_qsv`), and
  `libplacebo`. The frame-by-frame PNG round-trip in `edit.js` — extract every frame to PNG, crop in
  Node with `sharp`, re-encode — is the slowest stage in the pipeline and mostly exists because the
  face crop is done outside ffmpeg. With a precomputed crop path it could be a single
  `sendcmd`-driven filtergraph.
- **`minterpolate` and `librubberband`** are both available on WSL, if we ever want speed-ramping or
  pitch-preserved pace adjustment.

---

## 5. The end-state workflow

### 5.1 The loop

```
   ┌─ 1. BRIEF ──────────────────────────────────────────────────────────┐
   │  Cole/Sage picks the topic from the content mix (Std §15) and       │
   │  writes: verbatim HOOK (10-14 words) + 3-5 BULLETS + verbatim CTA.  │
   │  NOT a full verbatim script. (§2.4)                                 │
   └─────────────────────────┬───────────────────────────────────────────┘
                             ▼
   ┌─ 2. RECORD (Heath, ~10 min) ────────────────────────────────────────┐
   │  Chunked takes, one thought per take. Hook read; body spoken.       │
   │  Setup minimums in §5.3. Deliberate throwaway take first.           │
   └─────────────────────────┬───────────────────────────────────────────┘
                             ▼
   ┌─ 3. EDIT (engine, unattended) ──────────────────────────────────────┐
   │  transcribe → cutlist + SHOT PLAN → J/L-cut render → grade →        │
   │  animated captions → b-roll as L-cut overlay → voice chain +        │
   │  ducked music + room tone → −14 LUFS master                         │
   └─────────────────────────┬───────────────────────────────────────────┘
                             ▼
   ┌─ 4. REVIEW (review.js) ─────────────────────────────────────────────┐
   │  Grades §17 QC + §22. PASS → surface. FAIL → patch brief, loop      │
   │  (max 3). RESHOOT → stop, name what the footage lacks.              │
   └─────────────────────────┬───────────────────────────────────────────┘
                             ▼
   ┌─ 5. PUBLISH ────────────────────────────────────────────────────────┐
   │  Heath approves via Telegram → clean per-platform master →          │
   │  IG as a Trial Reel first → post_analytics → back into the brief    │
   └─────────────────────────────────────────────────────────────────────┘
```

### 5.2 What each stage still needs

| Stage | Gap today | What it needs |
|---|---|---|
| 1. Brief | We write full verbatim scripts | A hook/bullets/CTA brief format, plus an "interview yourself" question-list variant (§2.4) |
| 2. Record | Ad-hoc; take 1 was unusable | The setup checklist in §5.3, in Heath's hands before he presses record |
| 3. Edit | **Cannot change the picture** (§4.1); b-roll kills the voice (§4.2); no ducking (§4.3); no room tone or J/L cuts (§4.4); no grade (§4.5); Arial static captions in the UI zone (§4.6) | Shot-plan in the cutlist; overlay b-roll; `sidechaincompress`; independent a/v trim + `acrossfade` + room tone; the §1.6 grade; animated libass captions at `MarginV ≥ 700` |
| 4. Review | Good, but 9 of 28 fixes have no editor knob, so the loop dead-ends | Once §4.1/§4.2 land, wire those fixes to real brief fields (`shotPlan`, `brollInserts`, `musicDuckDb`) |
| 5. Publish | No delivery ever verified — all 23 posted `video_library` rows have `zernio_deliveries = []` (audit §9.2) | Delivery verification; Trial Reels as the IG default; send-per-reach as the tracked metric (§3.5) |

**Also unresolved and outside this document's scope:** the supply loop was dead 4 days, the scheduler
checkout was 66 commits stale, and all engine code is uncommitted (§4.8). A better editor that never
runs produces nothing.

### 5.3 What HEATH has to do differently at the recording stage

The first take was phone-mic audio in a hard room, script off-camera, over-ear headphones on. Three
of those four are fatal or near-fatal in post, and §1.5 is clear that **room reverb is the one thing
the edit genuinely cannot remove.** In rough order of how much each one buys:

1. **Get a lav mic on his shirt, 6-8 inches from his mouth.** [CONVENTION] The problem with a phone
   mic across a room isn't the capsule, it's the ratio of direct sound to room reflections. A $25 lav
   fixes the ratio. This is the single biggest audio improvement available and it is not close.
2. **Kill the room.** Hang a duvet or heavy blanket behind the camera and one to the side; put a rug
   down; **do not stand between two parallel hard walls** or in the centre of the room. Don't
   over-treat — a fully dead room sounds lifeless.
   [Home Studio Basics](https://homestudiobasics.com/acoustic-sound-treatment-for-microphones/)
3. **Take the headphones off.** They read as visually intrusive, they tether him, and they break the
   eye-contact illusion. (One creator reported 3-5x better performance after switching to a
   no-headphone, standing, direct-to-lens style — **single anecdote, not a study**, but the visual
   argument stands on its own.)
4. **Get the script on the lens axis, or stop reading it.** Either prompter within ~15° of the lens
   at 9-12 feet with a narrow text column (§2.5), or — better — hook memorised and body from bullets
   (§2.4). Right now the eye-flick is being created at the recording stage and there is no edit that
   removes it; `review.js` already measures it (`eyeContactFailShare: 0.45`) and can only report it.
5. **Stand up. Record in chunks. Throw the first take away on purpose.** (§2.6)
6. **Shoot 4K, lock exposure and focus before rolling.** 4K gives the punch-in headroom §4.1 needs
   (`edit.js` already scales to a 2880px intermediate for this). Locked exposure prevents the
   auto-exposure hunting that no grade can fix.
7. **Leave 2 seconds of silence rolling at the top and tail of every take** — that is the room tone
   the edit needs (§1.5), and it costs nothing.
8. **Window as key light, off to one side, never behind him.**

---

## 6. Honest summary of where this research is thin

I would rather name these than let them get quoted back as fact later.

- **Cut cadence numbers.** No evidence for any specific cuts-per-second target in short-form. The
  2-3s perceptual window is real; its application as an editing rule is not.
- **Punch-in scale threshold.** Nobody quantifies it. My 1.15x-1.35x band is taste.
- **B-roll lead-in duration.** Universally asserted, never quantified. My 150-300 ms is taste.
- **Setup vs. punchline b-roll.** No video-editing source addresses it. My reasoning from comedy
  editing craft is labelled inference.
- **Whooshes/risers in founder content.** No direct source found.
- **Colour grade numeric values.** No source gave a saturation % or curve shape.
- **Caption position drift through a video.** No source either way.
- **TikTok/IG/FB loudness targets.** Confirmed by a specialist source to be industry guesses.
  Only YouTube's −14 LUFS is published.
- **TikTok "test batch" for new accounts.** Not in any TikTok statement I could reach.
- **The cost of a weak first second, as a number.** Structurally certain, numerically unpublished.
- **YouTube Shorts' swipe-away thresholds** and the Tubular 4x figure. Could not verify the report.
- **Creator Insider / Rene Ritchie 2025-26 Shorts statements.** Could not retrieve any. Anything
  attributed to them on Shorts ranking is unverified by this pass.
- **Research budget note:** the session's WebSearch quota (200 queries) was exhausted partway
  through; the tail of the algorithm and script research ran on direct fetches, and several official
  pages 404'd or were JS-rendered and unreadable. The TikTok transparency-centre body text, the
  Tubular report and Creator Insider transcripts are the three worth re-running when quota resets.
