# Video Production Recipe — the TREC ¶7.I "water disclosure" cut

**Status:** proven. Every number in this document was measured on real output, not estimated.
**Reference output:** `dossie_water_FINAL_V8.mp4` — 1080x1920, 30fps, 1535 frames, 51.167s.
**Produced:** 2026-09-24. **Recorded:** 2026-09-22 (5 takes).

> Heath, on the day it finished: *"Let's save the whole process now locally in the computer so we
> never forget how we made this video. We're onto something here."*

This is the first Dossie video that cleared the bar in
[`docs/DOSSIE-CREATIVE-DIRECTOR-STANDARD.md`](./DOSSIE-CREATIVE-DIRECTOR-STANDARD.md) — read that
first. It is the rubric; this document is the build. Where the two disagree, the Standard wins.

The working files are checked in at **`scripts/video-engine/recipes/trec-7i/`**. Large derived
media (frame directories, intermediate mp4s, the page strip) is deliberately *not* checked in —
§16 says how to regenerate each piece.

---

## 1. Source footage

5 takes, shot on a phone held landscape with `rotation=-90` metadata, so they are portrait in
practice.

| Property | Value |
|---|---|
| Container resolution | 2560x1440, `rotation=-90` (displays 1440x2560) |
| Frame rate | 30 fps |
| Codec | HEVC |
| Takes | 5 (IDs below are the recording clock-time stamps: `132818`, `133111`, `133237`, `134337`, + 1 unused) |

Crop to a clean vertical master:

```
crop=in_h*9/16:in_h,scale=1080:1920,fps=30,setsar=1
```

`in_h` is used for both terms because the rotation metadata has already been applied by the
decoder — the frame is 1440x2560 at filter time, so `in_h*9/16` = 1440 and the crop is a no-op
horizontally while forcing the exact 9:16 box. `setsar=1` prevents a non-square-pixel master from
poisoning every downstream overlay coordinate.

---

## 2. Mic detection — the level test, not the channel test

The DJI lav records **left-channel only**. Channel 2 measures **-90.3 dB** (digital silence).

**This does NOT identify a mic'd take.** Every one of the 5 takes showed a silent right channel,
including the take recorded without the lav. Channel layout tells you nothing here.

The only reliable discriminator was **level**:

| Take | Mean volume |
|---|---|
| mic'd | -20.8 dB |
| mic'd | -21.4 dB |
| mic'd | -22.0 dB |
| mic'd | -23.0 dB |
| **un-mic'd** | **-27.0 dB** |

The un-mic'd take ran ~6 dB quieter than the quietest mic'd take. That gap is the tell.

```bash
ffmpeg -nostdin -i TAKE.mp4 -af "volumedetect" -f null - 2>&1 | grep mean_volume
ffmpeg -nostdin -i TAKE.mp4 -af "channelsplit=channel_layout=stereo[l][r];[r]volumedetect" -f null - 2>&1 | grep mean_volume
```

**Production fix — ask Heath to tap the mic at the top of every take.** A 6 dB inference is a
guess that happened to be right; a tap is a fact. A 6 dB spread is well within the range a
different room, a different distance, or a louder delivery could produce on its own.

---

## 3. Multi-take sentence selection — the core technique

This is what made the video work. **No single take was publishable.** The final cut is 16
sentences; **10 of them come from a take other than the spine.** See
`scripts/video-engine/recipes/trec-7i/shot-plan/plan4.json` for the exact result, and the
`multi-take-splice-workflow` memory for the general method.

### 3.1 Transcribe every take with word timings

ElevenLabs, model **`scribe_v1`**, `timestamps_granularity=word`. Per-word `logprob` is required —
it is the scoring signal in §3.3 and no other provider in this stack returns it.

### 3.2 Align the takes

1. Split each transcript on terminal punctuation into sentences.
2. Align sentences across takes with `difflib.SequenceMatcher` on **normalised** text.
3. Treat two sentences as the same sentence when the ratio is **> 0.78**.

> **Normalisation trap — this cost a real debugging cycle.** Stripping all non-letter characters
> turns `"7I"` into `"i"`. An intact phrase then looks like it has a dropped word, and the scorer
> throws away a perfectly good take. **Keep digits when diffing.** Lowercase and strip punctuation,
> but never strip `[0-9]`.

### 3.3 Score each candidate and take the lowest

```
key = (disfluencies + doubled_words, -sum(logprob))
```

Lower wins. Ties on the first term break on the second.

**`logprob` per word is the slur/mumble detector.** `0.0` = the model is certain it heard that
word. A word Heath swallowed scores badly even when the transcript text is correct, which is
exactly the flaw a text-only diff cannot see. This is the single highest-value part of the
technique.

### 3.4 Pad the splices

- **Head pad: −0.12s** (start 120ms early — catches the consonant onset).
- **Tail pad: `min(0.20, gap_to_next_sentence * 0.45)`**

> **A flat 0.20s tail pad duplicates the next sentence's first word.** It shipped once as
> *"If, if the seller"*. When the speaker runs two sentences together the gap is under 0.2s, and a
> fixed pad reaches straight into the next word. Scale the pad to the gap.

### 3.5 Result

16 sentences, 10 pulled from non-spine takes, zero audible flaws. Take usage in `plan4.json`:
`134337` x6 (spine), `132818` x5, `133111` x3, `133237` x2.

---

## 4. Sync rule — assert it, don't trust it

**Shipped bug:** speed adjustment was applied in *both* the frame filter *and* the output
framerate. The two multiply. The picture ran at 1.166x against audio at 1.08x, and his body
finished the video **18 seconds before his voice did**.

Apply speed in exactly one place. Then assert:

```
abs(frameCount / fps - audioDuration) < 0.050   # 50 ms
```

Reference output passes exactly: `1535 / 30 = 51.1667s`, audio `51.1667s`, drift **0 ms**.

```bash
ffprobe -v error -select_streams v -show_entries stream=nb_frames,r_frame_rate -of csv=p=0 OUT.mp4
ffprobe -v error -select_streams a -show_entries format=duration -of csv=p=0 OUT.mp4
```

`scripts/video-engine/sync-guard.js` exists for this check — wire it in rather than eyeballing.

---

## 5. Matte (background separation)

Use **`scripts/video-engine/matte.js --mode rgba`**.

> **Naming note:** this step was run during the session as `matte-fast.js`. There is no
> `matte-fast.js` in the repo — the fast path is `--mode rgba` on `matte.js`, which is the
> **default**. Anyone reading a shell log that says `matte-fast.js` wants `matte.js`.

Two things make it fast:

1. **`--mode rgba` writes ONE RGBA PNG per frame** instead of the legacy 3-file-per-frame output
   (`alpha` + `fgr` + `comp-blurbg`). The RVM model pass was never the bottleneck — the PNG
   encodes were. `matte.js` documents 5.7 fps vs **0.65 fps** for `--mode full`; this session
   measured **~4-5 fps**. Either way it is ~7-9x.
2. **Stage frames on the native Linux filesystem, not `/mnt/c`.** The 9p filesystem translation
   dominates a workload that is hundreds of thousands of small file writes. Use the scratchpad or
   `~/`, then copy the finished product back to `/mnt/c`.

Feed it **640px-wide input**. RVM downsamples to 512 internally, so anything larger is thrown away
after costing full-resolution I/O.

---

## 6. Document background (the scroll)

The b-roll is the real TREC 20-19 contract, scrolling behind him.

### 6.1 Build the page strip

```bash
pdftoppm -f 3 -l 5 -r 200 -png scripts/trec-forms/20-19.pdf pg
ffmpeg -y -i pg-03.png -i pg-04.png -i pg-05.png -filter_complex vstack=inputs=3 strip.png
```

Pages 3-5 at 200 DPI are **1700x2200** each; vstacked the strip is **1700x6600**. *(Both verified
against the tracked PDF on 2026-09-24.)*

### 6.2 Viewport

```
crop=1080:1920:110:<Y>
```

x=110 centres the 1080 window in the 1700 strip with a slight left bias that keeps the paragraph
letters (A., B., I.) fully in frame.

### 6.3 Motion

**Settle** — ease-out cubic from the top of the page into the target, over duration `D` starting
at `T0`:

```
Y = 325 + (4600 - 325) * (1 - pow(1 - ((t - T0) / D), 3))
```

**Idle drift** — once settled, never let it sit perfectly still:

```
Y = 4600 + 30 * sin(t / 6)
```

A 30px amplitude on a 6-second period is below conscious notice but keeps the frame alive, which
matters because §10 forces a small, static subject over this window.

**`Y = 4600` lands the viewport on ¶7.I of page 5** — verified by rendering the crop: the window
contains *"I. SELLER'S DISCLOSURE ABOUT GROUNDWATER AND SURFACE WATER"* and its three check boxes.

---

## 7. Circle annotation

`scripts/video-engine/recipes/trec-7i/scroll/circle.html` +
`scripts/video-engine/recipes/trec-7i/scroll/shotcirc.js`.

A hand-drawn-looking red ellipse that draws itself on around ¶7.I.

| Parameter | Value |
|---|---|
| Geometry | `<ellipse cx="530" cy="1330" rx="495" ry="265">` |
| Tilt | `transform="rotate(-1.5 530 1330)"` — the off-axis tilt is what reads as hand-drawn |
| Stroke | `#E8433C`, width `13`, `stroke-linecap="round"` |
| Draw-on | `stroke-dasharray` = computed perimeter (**2450**), `stroke-dashoffset` animated 2450 → 0 |
| Frames | **21** |
| Easing | `1 - (1 - p)^2` (ease-out quadratic) |
| Capture | Playwright, `omitBackground: true` (transparent PNG sequence) |

The dasharray must equal the ellipse perimeter or the stroke will finish early or never close.
2450 is the Ramanujan approximation for `rx=495, ry=265` (≈2442) rounded up.

> **Time the circle to the word, not to the clock.** An early cut drew it at **4s** while Heath
> did not say the paragraph name until **19s**. It annotated the wrong moment and told the viewer
> the wrong thing was important. Pull the trigger time from the word timings in §3.1.

---

## 8. Document snip card (the proof card)

A cropped, highlighted card of the actual clause, floated over the dimmed background.
Pre-built plate: `scripts/video-engine/recipes/trec-7i/plate/snip_hl.png`.

Built at **300 DPI** (not the 200 DPI used for the scroll strip — the card is read, the strip is
not):

```
crop=2280:262:158:2082,
scale=1030:-2,
drawbox=x=8:y=62:w=1014:h=30:color=#FFE9A8@0.55:t=fill,
pad=1070:ih+44:20:22:white
```

then a `#E8A33D` border at `t=6`. Composited at **y=326** with the background pushed back:

```
eq=brightness=-0.34:contrast=0.94
```

> **Known limitation — the card is PROOF, not reading material.** At full contract line width the
> type lands around **13px** on a 1080-wide frame. Nobody reads it. Its job is to prove the clause
> is real and on the page; **the captions carry the actual words.**
>
> A 2x pan across the real line was built and **rejected**: with 34 lines of contract on screen the
> viewer cannot find the one being quoted, so the pan reads as noise. The dim-plus-highlight
> treatment above is what survived.

---

## 9. Captions

Final file: `scripts/video-engine/recipes/trec-7i/captions/caps4h.ass` (70 lines). The style line
ships verbatim — do not re-derive it:

```
Style: Cap,Plus Jakarta Sans ExtraBold,80,&H00FFFFFF,&H00FFFFFF,&H00101010,&HC0000000,-1,0,0,0,100,100,1,0,3,20,0,8,80,80,175,1
```

Decoded, the load-bearing fields:

| Field | Value | Why |
|---|---|---|
| Fontsize | `80` | on `PlayResX 1080` / `PlayResY 1920` |
| BorderStyle | `3` | **opaque box**, not outline — survives a white contract background |
| Outline | `20` | box padding, not stroke width, when BorderStyle=3 |
| Alignment | `8` | top-centre |
| MarginV | `175` | see below |
| BackColour | `&HC0000000` | 75% black box |

**`Alignment 8` + `MarginV 175` is the whole trick.** Top-centre keeps the captions off his face,
and it keeps them out of **Instagram's bottom-35% UI zone** where Reels overlays the caption,
handle, and action rail. Bottom-thirds captions get covered on the platform that matters most.

**Chunking:** break on **3 words OR 19 characters OR a gap > 0.4s** — whichever hits first.

**Emphasis colour:** `&H43C5F5&`. Applied per-word on the terms that carry the claim — *WALK*,
*EARNEST MONEY*, *JULY FIRST*, *TWENTY*, *SEVEN I*.

**Pop-in, on every event:**

```
{\fad(40,60)\t(0,90,\fscx105\fscy105)\t(90,160,\fscx100\fscy100)}
```

> **Suppress caption events underneath the hook card** — the first ~**3.05s**. Both are
> top-aligned; run them together and they collide into unreadable mush.

---

## 10. Shot plan (framing over time)

Checked in as ffmpeg expressions: `shot-plan/w4b.txt` (width) and `shot-plan/x4b.txt` (x offset).
Both are `between(t, ...)` ladders, bottom-aligned, driving the `overlay`/`scale` of the matted
subject over the document background.

**Cut rule:** change framing on a **gap > 0.42s** or on terminal punctuation. **Minimum segment
2.3s.** That produced 9 framing segments across 51s.

**The look rotation** — `(width, x)`:

```
(620, 420)   (980, 10)   (780, 270)   (880, 120)
```

**Two forced overrides — these are the rule, not the exception:**

| Window | Forced look | Why |
|---|---|---|
| Document-emphasis (`15.57s`–`39.80s`) | **`(440, 590)`** | small and pushed right, so **he never covers the evidence** he is pointing at |
| CTA (`46.6s`–`51.2s`) | **`(430, 600)`** | clears the CTA panel |

The `max(440, ...)` wrapper in `w4b.txt` is a floor that guarantees he never shrinks below
readable, whatever the ladder evaluates to.

---

## 11. Audio chain

```
pan=mono|c0=c0+c1,
highpass=f=80,
adeclip,
acompressor=threshold=-20dB:ratio=3:attack=5:release=140,
loudnorm=I=-16:TP=-1.5:LRA=11
```

`pan=mono|c0=c0+c1` comes first because of §2 — the lav is on one channel and the other is digital
silence. Sum, don't average, or you lose 6 dB. `loudnorm I=-16 TP=-1.5` is the social-platform
target. See also `scripts/video-engine/audio-chain.js`.

---

## 12. Music — three iterations, all three worth remembering

Track: **`documentary-trust-piano.mp3`** from `Media/Music/` (12 licensed Pixabay tracks; see
`Media/Music/LICENSE.md`).

> **`Media/` is gitignored** (`.gitignore:159`). The music library is **local-only** and is not
> recoverable from this repo. Do not assume a fresh clone has it.

| Iteration | Setting | Result |
|---|---|---|
| 1 | **-26 dB** + sidechain **ratio 9** | **INAUDIBLE.** Rejected. |
| 2 | **-9 dB** | 15 dB under voice — audible, but thin. |
| 3 | **-4 dB** | Pushed the limiter to 0.0. Too hot. Rejected. |
| **Final** | **-6 dB** | ≈**8 dB** under voice. Shipped. |

**Why iteration 1 failed, and it is not obvious:** Heath speaks *continuously*. There is **no gap
longer than 0.45s in the entire 51 seconds.** A sidechain ducker needs silence to release into;
with none, it simply held the bed down for the whole video. A music bed under a wall-to-wall VO
needs a **static level that is already correct**, with the sidechain doing only fine trimming.

**Final chain:**

```
sidechaincompress=threshold=0.06:ratio=3.5:attack=12:release=420,
amix=inputs=2:weights=1 0.9,
alimiter=limit=0.95
```

---

## 13. Hook and CTA cards

Sources: `recipes/trec-7i/cover/hook.html`, `recipes/trec-7i/cover/cta.html`, rendered by
`recipes/trec-7i/cover/shotel.js` (Playwright, `omitBackground: true`, height as `argv[4]`).

> **Render each card to an ALPHA VIDEO CLIP, not a still PNG.**
>
> ```bash
> ffmpeg -loop 1 -framerate 30 -i card.png -t <dur> -c:v qtrle card.mov
> ```
>
> **A still PNG fed into a `fade` filter does not animate and renders nothing.** This shipped
> once as completely invisible cards. `fade` needs a time base; a single image input does not have
> one until you loop it into a clip.

Overlay with `-itsoffset <t>` and `eof_action=pass` (without `eof_action=pass` the composite ends
when the short card ends).

- **Hook card** — 1080x640, transparent, top-aligned. Yellow `#F5C543` slab tag + 104px
  ExtraBold headline. Runs the first ~3.05s, with captions suppressed under it (§9).
- **CTA card** — 1080x420. **It carries its own dark panel:** `rgba(10,10,20,.93)` with a
  `rgba(245,197,67,.55)` 3px border.

> **The CTA panel is not decoration.** White text was first placed directly over the light
> contract background and was **unreadable** — the exact contrast failure the craft research
> names. Any text landing over the document needs its own opaque backing.

---

## 14. Cover image

`recipes/trec-7i/cover/cover924.html`, rendered full-frame 1080x1920 by
`recipes/trec-7i/cover/shot.js`. `PERSON` in `<img class="person" src="PERSON">` is replaced with
the path to the matted subject before rendering.

Three rules:

1. **It is a SEPARATE asset. It is NOT baked into the video.** Platforms accept it as the
   thumbnail. A title card welded to the front of the video **violates §2 of the Creative Director
   Standard and kills the opening** — the first frame has to be the story, not a poster.
2. **The hook text must be the video's own opening line.** Here: *"TWO DAYS FROM CLOSING. THEY CAN
   STILL WALK."* — matching the spoken open and `hook.html`. A cover that promises something the
   first sentence doesn't deliver is a bounce.
3. **Use a posed shot from the photo bank, matted — never a video frame.** Grabbed video frames
   catch mid-blink, mid-syllable, mid-gesture. See `docs/HEATH-PHOTO-SHOT-LIST.md`.

---

## 15. Build order

1. Crop + normalise all takes (§1).
2. Level-check every take; drop the un-mic'd one (§2).
3. Transcribe each take, `scribe_v1`, word granularity (§3.1).
4. Align, score, select per sentence; pad; emit `plan4.json` (§3.2-3.4).
5. Concat the selected audio; run the audio chain (§11).
6. **Assert sync** (§4).
7. Extract frames at 640px → `matte.js --mode rgba` on the native Linux fs (§5).
8. Build the page strip + scroll expression (§6); render the circle sequence (§7); build the snip
   plate (§8).
9. Composite: background → subject via shot-plan expressions (§10) → snip card → circle.
10. Burn captions (§9).
11. Overlay hook + CTA alpha clips (§13).
12. Mix music (§12), limit, mux.
13. Render the cover separately (§14).

---

## 16. Regenerating the derived media

Intentionally **not** checked in — all of it is reproducible and large:

| Artifact | Regenerate with |
|---|---|
| `strip.png` (1700x6600) | §6.1, from tracked `scripts/trec-forms/20-19.pdf` |
| Frame directories (`frames/`, `rgba/`) | `ffmpeg` extract at 640px → `matte.js --mode rgba` (§5) |
| Circle PNG sequence | `node recipes/trec-7i/scroll/shotcirc.js recipes/trec-7i/scroll/circle.html <outdir>` (§7) |
| Hook / CTA PNGs + `.mov` | `node recipes/trec-7i/cover/shotel.js <html> <png> <height>` then the `qtrle` loop (§13) |
| Cover PNG | `node recipes/trec-7i/cover/shot.js <html> <png>` (§14) |
| Intermediate + final mp4s | the build order in §15 |

`plate/snip_hl.png` **is** checked in — it is small and its crop coordinates are tied to one
specific 300 DPI render that is tedious to reproduce exactly.

---

## 17. Known gaps

**`scripts/video-engine/review.js` is mis-calibrated for this format.** Do not gate this recipe on
it as-is.

- It counted the scrolling document as **227 cuts** (reported). Re-measured on V8 with the same
  detector: **216**. Either way the number is meaningless — `review.js` calls
  `sceneCuts(video, 0.08)`, an ffmpeg `gt(scene,0.08)` frame-difference test, and a continuously
  scrolling full-frame document trips it on nearly every frame. Reproduce:

  ```bash
  ffmpeg -nostdin -i OUT.mp4 -vf "select='gt(scene,0.08)',showinfo" -an -f null - 2>&1 | grep -c pts_time:
  ```

- It wants a **tighter punch-in**, which would **hide the clause** — directly against the §10
  forced `(440, 590)` framing whose entire purpose is to keep the evidence visible.

Until `gate-calibration.json` grows a doc-explainer profile, treat `review.js` output on this
format as advisory. Its calibration file already says it was measured from **one** 6-second
real-footage sample and is "not a final number."

**Other gaps:**
- `scripts/video-engine/music-manifest.json` lists only **2** tracks and does **not** include
  `documentary-trust-piano.mp3`, though `Media/Music/` holds 12. The manifest is stale.
- `docs/DOSSIE-CREATIVE-DIRECTOR-STANDARD.md` and `docs/HEATH-PHOTO-SHOT-LIST.md` exist on disk in
  the main working tree but are **untracked in git** as of 2026-09-24. Both should be committed —
  this recipe references them and a fresh clone will not have either.

---

## 18. Files in this recipe

`scripts/video-engine/recipes/trec-7i/`

| Path | What |
|---|---|
| `captions/caps4h.ass` | Final caption file — ships the proven style line (§9) |
| `cover/hook.html` | Opening hook card, 1080x640 alpha (§13) |
| `cover/cta.html` | CTA card with its own dark panel, 1080x420 alpha (§13) |
| `cover/cover924.html` | Full-frame 1080x1920 thumbnail (§14) |
| `cover/shot.js` | Playwright full-frame screenshot |
| `cover/shotel.js` | Playwright transparent element screenshot (`omitBackground`) |
| `scroll/circle.html` | Parametric draw-on ellipse, `?p=` 0→1 (§7) |
| `scroll/shotcirc.js` | Renders the 21-frame eased circle sequence (§7) |
| `shot-plan/w4b.txt` | Subject width expression (§10) |
| `shot-plan/x4b.txt` | Subject x-offset expression (§10) |
| `shot-plan/plan4.json` | Take-selection result: 16 sentences, `[take, start, end, idx]` (§3.5) |
| `plate/snip_hl.png` | Pre-built highlighted ¶7.I proof card (§8) |

---

## 19. The three bugs that shipped

Worth reading on their own, because each one passed a backend check and failed in front of a
viewer:

1. **Double speed application** (§4) — body finished 18s before the voice.
2. **Still PNG into a `fade` filter** (§13) — hook and CTA cards rendered completely invisible.
3. **Flat 0.20s tail pad** (§3.4) — duplicated the next sentence's first word: *"If, if the
   seller"*.

Plus two that were caught in review: the circle firing 15s before the words it annotated (§7), and
white CTA text on a light contract (§13).
