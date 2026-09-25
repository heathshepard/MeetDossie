# Dual-cut production — one recording, both platform cuts

**Status:** built and proven 2026-09-25 against `dossie_water_FINAL_V8.mp4`.
This is the standing production process. `docs/VIDEO-PRODUCTION-RECIPE.md` is how a master gets
made; this is what happens to it afterwards, every time.

---

## 1. The problem

The 2026-09-25 42-second cut existed because a script was written with **no length target**, then
hand-trimmed toward one at edit time, then rejected by `scripts/check-video-quality-cli.js` for
fitting neither TikTok's 21–34s window nor Instagram's.

That is a script-time failure being paid for at edit time, by hand, once per video. And on the
same day a finished, gate-passing video sat in `Downloads` and never reached the posting queue,
because putting it there was a thing a human had to remember.

## 2. The design — CORE / OPTIONAL

Every chunk of a script is tagged.

| Cut | Contents | Target | Goes to | Gate lane |
|---|---|---|---|---|
| **core** | CORE only | ~30s (21–34s) | TikTok, Instagram Reels | `vertical` |
| **full** | CORE + OPTIONAL | ~50–60s (40–90s) | YouTube Shorts, Facebook, LinkedIn | `vertical_long` |

**Aspect ratio is not a variable.** 9:16 1080x1920 for both. This is purely length.

CORE always carries **the hook, the one rule, and the CTA**. OPTIONAL carries context, the second
example, the elaboration. *A core-only cut must stand alone as a coherent video* — that is a
constraint the parser enforces, not an aspiration.

### The tag

A tag is a marker line, in the same family as `[pause]` and `` `[FACE]` `` / `` `[SCREEN: …]` ``
that the verbatim format already uses. **It never appears in what Heath reads.**

```
`[CORE]`

You're writing an offer and you want
the seller to help pay
your buyer's side.

`[OPTIONAL]`

Seller toward what the buyer owes the buyer's broker.
Buyer toward what the seller owes the seller's broker.

`[CORE]`

That's two of six.
Follow for the other four.
```

A tag sets the mode for every chunk after it until the next tag. A tag boundary always closes the
chunk in progress — a chunk is never half CORE. Untagged scripts default to CORE, so an untagged
script is still a valid short; it is never silently empty.

### `### CORE MUST CARRY` — the accuracy gate

Every script in `docs/SCRIPTS-TREC-20-19-SERIES.md` has MUST BE EXACT and MUST NOT SAY tables
because dropping one qualifier turns a true statement into a false one on camera:

| Written | What a careless trim leaves |
|---|---|
| "**may** provide Buyer with remedies" | "gives your buyer a right to terminate" |
| "**more than** 10%" | "ten percent" |
| "other than **brokerage compensation**" | "brokerage compensation" |
| "fax only left **twenty-one**" | "fax was removed from the contract" |

A length trimmer will cut every one of those, because they are short and read like filler. So each
script declares the phrases the core cut must still contain:

```
### CORE MUST CARRY
- "may"
- "more than ten percent"
```

`scripts/video-engine/script-format.js` **fails the parse** when a listed phrase is absent from the
core-only text. A core cut that would state a rule without its condition is an error, not a
judgement call made later by whoever is editing.

### The pace band — why tagging happens BEFORE the shoot

One recording produces both cuts, so both cuts are read at the same words per minute. The two
length windows are therefore a single simultaneous constraint on one number:

```
core_words / P * 60  must be in [21, 34]
full_words / P * 60  must be in [40, 90]
```

`script-format.js` solves that and prints the feasible band per script, plus the intersection
across a series (the recording block says shoot all five in one sitting — one sitting is one
pace). An **empty band means no delivery speed exists** at which this script yields two compliant
cuts. That is a fact about the script, discoverable at the desk in two seconds, and no amount of
editing afterwards can fix it.

```bash
node scripts/video-engine/script-format.js docs/SCRIPTS-TREC-20-19-SERIES.md
```

---

## 3. Variant assembly

`scripts/video-engine/variants.js`.

Input is the segment list on the MASTER timeline, one segment per spoken sentence:

```json
{ "start": 27.29, "end": 40.15, "tag": "CORE", "text": "IF THE SELLER OWES…" }
```

Boundaries come from the splice step (`recipes/trec-7i/shot-plan/plan4.json`) or, for a master
built before tagging existed, from the caption file via `segmentsFromAss()`. The caption file is
the more reliable of the two: `plan4.json` holds PRE-pad source times (recipe §3.4 adds a −0.12s
head pad and a scaled tail pad per splice, which is why its durations sum to 47.08s against the
master's 51.15s).

> `segmentsFromAss()` **interpolates each cut to the punctuation character inside its caption
> event.** The proven chunker breaks on "3 words OR 19 characters OR a >0.4s gap", so a sentence
> end lands mid-chunk far more often than at a chunk edge — `AGO. INSPECTIONS` and
> `WHAT MATTERS. IF` are both single events. Cutting at event edges leaves a dangling `YOU'LL`
> hanging off the previous segment; requiring the punctuation at an event's end collapsed 16
> sentences into 3, one of them 38 seconds long.

**Both cuts come off the same matte frames and the same spliced master. Nothing is re-matted.**
Recipe §5 is the expensive step (hundreds of thousands of small PNG writes) and it is paid once
per recording, not once per cut. `copyFrameSlice()` hard-links frames out of the shared `rgba/`
directory; `ffmpegAudioFilter()` / `ffmpegVideoTrimFilter()` re-slice the audio and picture on the
**same** boundaries in one filter graph, so recipe §4's sync assertion still holds by construction.

Each variant gets its own:

| Artefact | Function |
|---|---|
| frame index ranges into the shared `rgba/` | `frameRanges()` / `copyFrameSlice()` |
| audio + video slice filters | `ffmpegAudioFilter()`, `ffmpegVideoTrimFilter()` |
| caption file remapped to the new timeline | `remapAss()` |
| contract-scroll + annotation cue points | `remapCues()` |
| shot-plan `between(t,…)` ladders | `remapShotPlan()` |

**Cues are carried as MASTER times and pushed through the same remap as everything else**, so a
cut that removes nine seconds ahead of the circle moves the circle by exactly nine seconds. Recipe
§7: "An early cut drew it at 4s while Heath did not say the paragraph name until 19s. It annotated
the wrong moment and told the viewer the wrong thing was important." A cue whose instant was cut
away is reported as ORPHANED, never silently relocated.

Caption events inside a removed span are **dropped, not clamped** — a clamped event stacks a
sentence nobody is speaking on top of one they are.

---

## 4. Per-variant gate

`scripts/check-video-quality-cli.js`, once per variant, with that variant's own lane:

```bash
node scripts/check-video-quality-cli.js --video core.mp4 --cover cover.png --orientation vertical
node scripts/check-video-quality-cli.js --video full.mp4 --cover cover.png --orientation vertical_long
```

`vertical_long` is new (`api/_lib/verify-video-quality.js`). It grades the long cut against the
same 9:16 frame rules and a **40–90s** runtime window. It had nowhere to be graded before:

* `--orientation vertical` caps at `HARD_MAX_RUNTIME_S = 45` and fails every 50–60s cut;
* `--platforms youtube,facebook,linkedin` classifies the row **horizontal** and demands a 16:9
  frame this pipeline deliberately does not produce for it.

90s is the binding real ceiling — Facebook Reels caps there; YouTube Shorts allows 3 minutes and
LinkedIn far more. The 40s floor is deliberate: a "long" cut under 40s means CORE+OPTIONAL is
barely longer than CORE, which is a script-tagging defect worth failing on.

The lane is **explicit-only** — no platform array maps to it, so every existing caller
(`queue-finished-videos.py`, `cron-post-videos.js`, the regression fixtures) is unchanged.

**A variant that fails its own gate is not queued, and says why.**

---

## 5. Auto-queue

`scripts/video-engine/queue-variant.js`. On gate pass, in the same run:

1. upload the mp4 to the Supabase **`videos`** bucket (public, 100MB, video/mp4) and the cover to
   `social-cards`;
2. insert the `video_library` row — `supabase_url`, `cover_url`, caption, this variant's
   `platforms`, the full gate result, and the per-platform slots resolved from `posting_schedule`;
3. status **`approved`**.

`approved` is the queue-entry step that was missing. `api/cron-post-videos.js` picks it up, sends
Heath the Telegram approve card (moving it to `pending_heath_review`), and only posts after his
tap. **Automating insertion is not the same thing as automating publication** — CLAUDE.md §3 is
explicit that Heath is the final gate, so `--approve` exists but is never the default.

It refuses to queue:

* a variant whose gate did not pass;
* an empty caption — `cron-post-videos.js` skips those forever, so queueing one is queueing
  something that looks done and can never post (exactly the state
  `dossie-water-2026-09-25` was left in);
* a row with no platforms.

**Zernio is called by the cron, not here.** `api/cron-post-videos.js` already carries
`lookupZernioPageId()` (without which a Facebook post lands on whichever Page Zernio's dashboard
has selected — a hand-rolled call on 2026-09-25 skipped it), owner-aware account routing,
`platformSpecificData.title` for YouTube, the AI-disclosure label, the schedule/cap gate and
delivery verification. A second copy here would be the copy that drifts.

---

## 6. Running it

```bash
node scripts/video-engine/produce-variants.js \
  --spec scripts/video-engine/recipes/trec-7i/variants.json \
  --dry-run                       # prove first; --dry-run uploads and writes nothing
```

Flags: `--only core|full`, `--from master|frames`, `--outdir DIR`, `--approve`.

Exit 0 = both variants passed. Exit 2 = at least one failed its gate (and was not queued).

### `headTrim`

The hook card **fades in**, so master frame 0 carries no hook text and the gate's blocking
`hook_visible_frame0` rule fails on a card that is really there. Verified by rendering frames on
2026-09-25: `0.000` is bare contract, `0.250` is the full `TEXAS AGENTS / TWO DAYS OUT. / THEY CAN
STILL WALK.` slab. `headTrim: 0.25` puts frame 0 on the opaque card and pulls the card's clear
point under the 3.0s `hook_cleared_by_3s` sample. It trims a fade, not content — both vision rules
went from FAIL to PASS on the full cut with no other change.

---

## 7. Tests

```bash
node scripts/regression-video-variants.js     # 54 checks, no ffmpeg/network/API key
node scripts/regression-twitter-length.js     # the 09-22/24/25 Twitter rejections
```

---

## 8. Known constraint — the ¶7.I master cannot make a compliant core cut

Proven, not predicted. Producing both cuts from `dossie_water_FINAL_V8.mp4`:

| Cut | Duration | Gate | Queued |
|---|---|---|---|
| core | **34.92s** | FAIL — `runtime_in_platform_range` (0.92s over TikTok's 34s ceiling) | no |
| full | **50.92s** | **PASS**, all 13 blocking rules | yes |

The binding constraint is one **12.86-second sentence** — "IF THE SELLER OWES YOUR BUYER THAT
DISCLOSURE AND IT NEVER GETS DELIVERED, THE BUYER CAN TERMINATE, NOT JUST DURING THE OPTION
PERIOD, AT ANY TIME BEFORE CLOSING … AND THE EARNEST MONEY GOES BACK TO THEM." It carries the rule
and all of its conditions and cannot be split without making the claim wrong. Add the hook (9.6s),
the form and its effective date (4.7s), the paragraph (5.1s) and the CTA (2.9s) and the accurate
floor is 34.9s against a 34s ceiling.

**This is not fixed in the edit. It is fixed in the script** — which is the entire point, and what
the five newly-tagged scripts in `docs/SCRIPTS-TREC-20-19-SERIES.md` now do before the camera
rolls.
