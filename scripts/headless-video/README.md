# Headless video lane

**Headless** = no camera time from Heath. Cloned/professional voice over footage we
already own, captions derived from that voice, finished 1080x1920 master + covers.

Filming is the bottleneck on daily posting. This lane removes it for the classes of
video that don't need his face.

```bash
python3 scripts/headless-video/build_headless_video.py specs/<name>.json
```

Outputs land in `Media/headless-videos/` (gitignored):
`<slug>.mp4`, `.cover.png` (1080x1920), `.cover_square.png` (1080x1080),
`.captions.ass`, `.cards.ass`, `.meta.json`, `.frames/`.
Intermediates go to `/home/heath/mw/headless/<slug>/` — native FS on purpose,
never `/mnt/`.

**This lane produces files and stops.** Nothing here posts, schedules, approves,
or registers anything for publishing.

---

## What is reusable, and what still needs a human

### Reusable — a new script next week costs one JSON file

| Stage | Status |
|---|---|
| Script → voice | Fully automatic. Beats in, one voice track out, per-beat TTS cached by content hash. |
| Voice → caption timing | Fully automatic and drift-proof by construction (see below). |
| Caption styling / chunking | Fully automatic. The locked style, pop-in and 3-word/19-char/0.4s chunking are in code. |
| Timeline fill | Fully automatic. The shot list cycles with rotating in-points to fill whatever runtime the new script happens to be, so changing the script does not mean re-timing the edit. |
| Audio mix | Fully automatic. Bed and voice are both levelled, then ducked, then the duck depth is **measured** and printed every run. |
| Covers | Fully automatic, both sizes, hook positioned to survive the 1:1 crop. |
| Gates | Fully automatic and fail-closed. Both proven by negative test, not assumed. |
| Verification frames | Automatic extraction. **Looking at them is not.** |

### Still hand-held — budget real time for these

1. **The script.** This is the whole job and no tooling replaces it. Energy is
   written, not produced; a flat script read faster is still flat.
2. **Fact verification.** Every claim goes against the primary source by hand.
   `pdftotext -layout scripts/trec-forms/20-19.pdf` and read the paragraph.
   The pipeline will happily render a false statement in a beautiful frame.
3. **Shot selection and in-points.** Picked by *looking* at a contact sheet, not
   by guessing. The first build of video 1 used `in: 1.2` on a clause recording
   and showed an unmarked wide page, because the gold highlight only comes up
   after the establishing shot. A contact sheet is one command:
   ```bash
   ffmpeg -i <clip> -vf "select='not(mod(n,65))',scale=224:400,tile=10x1" -frames:v 1 sheet.png
   ```
4. **Watching the result.** The gate is not sufficient — see
   `founder-video-production-standard.md` §7. Extract frames, including the
   worst-case busy background, and look.
5. **`music_gain_db`.** Tuned per track against the printed measurement. See below.

---

## Why captions cannot drift

Captions come from ElevenLabs `/with-timestamps`, which returns a character
alignment **for the exact audio samples that get concatenated into the master**.
There is one timeline, so a caption/audio mismatch is structurally impossible
rather than merely checked for. This satisfies the production standard's
"derive captions from the finished audio" requirement without a re-transcription
round trip (and this box has no local ASR at all — no whisper, no faster-whisper).

`alignment` is used rather than `normalized_alignment` because the former indexes
the *original* input string, so the words that come back are exactly the words
written in the spec.

**`caption_rewrite`** handles spoken-vs-written: a citation has to be spoken
"paragraph five E" for the voice to say it correctly, but a practising agent
scans for `¶5.E`. Each rule is `[spoken phrase, written text]`; the matched run
keeps its own timing. v9 hard-coded one such fix, this generalises it.

---

## The gates (both fail closed, both negative-tested)

**Voice/brand guard.** Heath's clone `i41TA0Q36AUrp4axERi3` is approved for
realtor-brand and Rust content only, never Dossie
(`heath-voice-clone-usage-scope.md`). A `brand: "dossie"` spec naming the clone
aborts before any TTS call is made.

> Verified 2026-10-03 by running a deliberately bad spec:
> `FATAL: VOICE GUARD: Heath's clone ... is approved for realtor-brand and Rust content only, never Dossie.`

**Privacy gate.** Every clip in a spec is looked up in its library index and must
be marked `clear`. Six Boerne clips are `flagged:` for recognisable faces, legible
plates, or identifiable private residences.

> Verified 2026-10-03 by injecting `boerne-main-street-shops-mobile-2024-12-17.mp4`:
> `FATAL: PRIVACY GATE: ... is 'flagged: faces' ... Flagged footage is never auto-selected or hand-selected into a post.`

A clip that is on disk but **not indexed** also aborts — unindexed footage is
never postable.

### Relationship to `select_local_broll_entries()`

That selector exists, on unmerged branch `feat/boerne-broll-catalog-1001`
(commit `eb9af637`), and currently has **zero callers** — it shipped an API and a
docs rule but was never wired into the render path. It selects *N clips by topic*,
which is the right shape for `generate-lifestyle-video.py` and the wrong shape
here: this lane needs a hand-authored shot list with per-shot in-points, durations
and motion, so what it needs from the library is a **per-file privacy check**, not
a selector. `resolve_clip()` is that check, and it covers both libraries.

**This is duplicated gate logic and that is worth knowing.** If `eb9af637` ever
merges, the two should be reconciled so the `clear`/`flagged` semantics live in
exactly one place.

---

## Audio: measure, don't assert

Standard is music ~18-19 dB under the voice. The chain levels **both** stems
before the sidechain, because a fixed `volume=-7dB` on an unlevelled bed made the
measured duck swing from 0.8 dB to 15.2 dB inside a single 32s render — the
sidechain can only pull down relative to what it is handed.

Nominal separation is `(|music_lufs| + |music_gain_db| - |voice_lufs|)` dB before
the sidechain adds anything. Defaults are -26 / -7 / -18 → 15 dB nominal. Tune
`music_gain_db` per track against the printed table; dense beds need more.

Measurement windows must sit **inside continuous speech**. Sampling from a bare
word start lets a 1.2s window straddle a pause, where the voice mean collapses
and a perfectly good mix reads as 1-6 dB.

Measured medians as shipped: video 1 ≈ 17.8 dB, video 2 ≈ 17.5 dB, video 3 ≈ 18.75 dB.

---

## Spec reference

| Key | Notes |
|---|---|
| `brand` | `realtor` or `dossie`. Drives the voice guard. |
| `voice_id` / `model_id` / `voice_settings` | Clone settings are LOCKED at 0.3 / 0.75 / 0.4 + speaker_boost on `eleven_v4`. Do not re-tune. |
| `speed` | `atempo`, pitch-preserving, applied in exactly one place. Keep ≤ 1.18. |
| `default_gap` / `gap_after` | Inter-beat silence. Tight gaps (0.14-0.17) read as energy. |
| `beats[]` | `{id, text, gap_after}`. One idea per beat. |
| `shots[]` | `{clip, in, dur, motion, src_crop, label}`. `motion`: `none` / `push` / `pull`. |
| `src_crop` | `"W:H:X:Y"` on the source, before scaling. |
| `hook_card` / `cta_card` | Hook is top-anchored and carries **no fade** — fully opaque in frame 0 by construction. CTA is also top-anchored so it can never land on the caption band. |
| `caption_suppress_until` | Normally equals `hook_card.until`. |
| `accent_words` | Gold accent. Keep it to citations/numbers — accenting a whole caption is not an accent. |
| `caption_rewrite` | `[["spoken phrase", "WRITTEN"], ...]` |
| `music` / `music_gain_db` / `music_lufs` / `voice_lufs` | Licence-clean `Media/Music/` only. |
| `cover_t` / `cover_hook_marginv` | Cover frame time; hook default 760 so it survives the 1:1 crop. |
| `verify_frames` | Times to extract. Always include 0.0 and either side of the hook clear point. |

### Picking music by measurement

```bash
python3 scripts/headless-video/measure_music_tempo.py
```

Prints BPM, a `drive` score (mean positive onset / mean RMS) and length for every
track. Worth running rather than trusting filenames: `energetic-driving-electronic.mp3`
has the **lowest** drive of all 12 tracks and is only 18s long.

BPM carries octave ambiguity and the `conf` column is low for most tracks — treat
`drive` and length as the usable signals.

---

## Known limitations

- **Contract body text is not phone-readable at 9:16.** A full page renders at
  ~10px and punching in cuts lines in half. The captions carry every word and the
  page carries the authority — the same division of labour as the approved v8/v9
  cuts. A genuinely readable clause would need a re-cut with a tighter bbox via
  `capture-screen-recording-trec-clause.js`.
- **Only one indexed portrait Dossie recording exists**, so video 3's variety comes
  from where in that one take each cut lands. The fix is more app footage, not
  more effects.
- **`push`/`pull` upscale.** Fine on a native 1080x1920 source, skip it on anything
  already upscaled.
- Covers are a frame grab plus a hook, not the composed face-plate layout that
  `generate-video-cover.js` builds — that one needs a face image and has nothing to
  work with here.

## Corrections this lane turned up

- **Luna's voice id is wrong in two places.** `CLAUDE.md` §2 and
  `heath-voice-clone-usage-scope.md` both say `lxYfHSkYm1EzQzGhdbfc`. Per the live
  `GET /v1/voices` listing that id is *"Jessica Anne Bogart"*. Luna is
  **`6rOxfAnZpbM3VIEhFaeV`** ("Luna - Calm & Grounded").
- **`dossier-deadlines-mobile-2026-09-30.mp4` is misdescribed** in
  `Media/screen-recordings/LIBRARY.md` as "1080x1920, 10.3s". It is **26.36s**, and
  the app content is a **540x960** capture padded into the 1080x1920 canvas with
  flat grey 128 (measured: content occupies rows 0..959, cols 0..539). Roughly the
  first 9s is the sign-in screen.
