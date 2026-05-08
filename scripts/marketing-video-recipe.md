# Marketing video recipe — beta-recruit-v1

The settings and workflow that produced `beta-recruit-v1-vertical-final.mp4` /
`beta-recruit-v1-square-final.mp4`. Reuse this for any 30-90s product demo /
recruit video.

## Pipeline at a glance

1. Write the script with explicit `<break time="X.Xs"/>` tags for pacing.
2. Generate ElevenLabs voiceover (one shot or two halves).
3. Record the screen demo (any aspect ratio — gets letterboxed if needed).
4. Manually download a music track to `Media/Music/` (Pixabay CDN blocks
   automated downloads; browser only).
5. Run the stitch script for vertical + square exports.

## ElevenLabs settings

The API key on this account has `text_to_speech` scope only — `voices_read`
is denied, so the voice list endpoint will 401. Use voice_ids directly.

### Voice library (preset, every account has access)

| Voice  | voice_id                | Notes                                    |
|--------|-------------------------|------------------------------------------|
| Bill   | pqHfZKP75CvOlQylNhV4    | Chosen for founder voice — calm, midrange |
| Brian  | nPczCjzI2devNBz1zQrb    | Warm, articulate, natural — strong B-side |
| Adam   | pNInz6obpgDQGcFmaJgB    | Clearer / less dramatic than Antoni       |
| Eric   | cjVigY5qzO86Huf0OWal    | Smooth, conversational                   |
| Daniel | onwK4e9ZLuTAKqWW03F9    | Articulate, measured                     |
| Antoni | ErXwobaYiN019PkySvjV    | More commercial / dramatic — avoid for founder feel |
| Josh   | TxGEqnHWrfWFTfGW9XjX    | Slightly upbeat                          |

### Model

`eleven_turbo_v2` — supports inline `<break time="X.Xs"/>` tags for explicit
pauses. No SSML wrapper needed; just embed the tags in plain text.

### Voice settings — Bill, founder-pace

For an even-paced single-shot:
- stability 0.45, similarity_boost 0.85, style 0.30, speed 1.00
- Tune speed iteratively to hit target duration (see
  `gen-beta-recruit-voiceover.py`).

When pacing is uneven (Bill rushes or drags), split into two halves with
different settings — that's what produced v4:

**Half 1 (energetic open):**
- stability 0.65, similarity_boost 0.75, style 0.4, speed 1.1

**Half 2 (warmer close):**
- stability 0.75, similarity_boost 0.75, style 0.2, speed 0.95

Concat halves with ffmpeg:
```
ffmpeg -i half1.mp3 -i half2.mp3 -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1" out.mp3
```

## Mix settings (final stitch)

- Voiceover: 100%
- Background music: 8% (subtle, fills silence)
- Music fade-in: 1s
- Music fade-out: 2s
- Video fade-in: 0.3s
- Video fade-out: 0.5s
- Voice fade-in/out: matches video (0.3s / 0.5s)

If voiceover is longer than the screen recording: freeze the last frame
(`tpad=stop_mode=clone:stop_duration=N`).
If shorter: trim with `trim=duration=N`.

## Output formats

- **Vertical** (Instagram Reels, TikTok): 1080x1920
- **Square** (Facebook groups): 1080x1080

Both use `scale=1080:-2:force_original_aspect_ratio=decrease` then `pad` with
black bars centered. A 4:3 source (e.g. 1392x1040) will letterbox top/bottom
on both — this is fine.

## Music

Pixabay direct CDN URLs (`cdn.pixabay.com/download/audio/...`) return 403
without a real browser session. Don't waste time on curl/Python — download
through the browser to `Media/Music/`, then point the stitcher at the file.

`background-music-real.mp3` (or whatever name you give it) just needs to be
≥ video length; the stitch script trims to fit, no loop needed if it's long
enough.

## Scripts to use

All under `scripts/`:

| Script                          | Purpose                                              |
|---------------------------------|------------------------------------------------------|
| `gen-beta-recruit-voiceover.py` | Single-shot voiceover with iterative speed tuning. Env vars: `VOICE_ID`, `OUTPUT_PATH`. |
| `gen-voice-tests.py`            | 10-second test clips for the 5 candidate male voices. |
| `gen-bill-v3-halves.py`         | Two-halves generation (use as template — edit script + settings). |
| `gen-bill-half2-v2.py`          | Single-half regen + concat (template).               |
| `stitch-beta-recruit-final.py`  | Final mix + 1080x1920 / 1080x1080 export.            |

### Quick recipes

**Test a different voice for the script:**
```
VOICE_ID=<voice_id> OUTPUT_PATH=Media/test.mp3 python scripts/gen-beta-recruit-voiceover.py
```

**Re-mix with different background:** edit `BG_MUSIC` in
`stitch-beta-recruit-final.py`, run.

**New script entirely:** clone `gen-bill-v3-halves.py`, swap the script
strings, keep the half1/half2 settings as starting point — they're tuned for
Bill specifically.

## Lessons from the v1 build

- Single-shot Bill voiceover (51.18s, speed 1.0) had uneven pacing — slow at
  start, rushed at end. Two-halves fixed it.
- `<break time>` tags add up — the v3 stitched output landed 60.33s
  (+6.33s over a 54s target) mostly because of cumulative pauses. Trim
  break durations before bumping speed if you're over budget.
- The 4:3 screen recording letterboxes inside both 9:16 and 1:1 frames.
  If you want full-bleed vertical, record the demo at 9:16 directly
  (e.g. mobile-emulated viewport).
- ElevenLabs free/low-tier keys are TTS-only. Don't bother trying voice
  list endpoints — they'll 401.
