# Render Feedback Log

Running record of issues found during lifestyle-video review and the permanent fixes that landed in `scripts/generate-lifestyle-video.py`. Every item below has a corresponding `RENDER_RULES` entry + enforced code path so the same issue can't reappear.

## 2026-05-06 — morning_brief render review session

### Issues found

1. **Outro fade clipped at end of file.** TAIL_PAD was 2.0s, leaving no buffer for the 1s fade-out + player buffering. Video felt like it cut off mid-fade.
2. **Dead air at start of screen recording.** The mobile capture had ~3s of static before any UI motion. That landed in the final video as a frozen frame.
3. **Voiceover hardcoded to Bill voice.** LIBRARY.md correctly tagged morning-brief-mobile recordings as Luna voice, but `synth_voiceover` ignored it. Brenda persona ended up with a male voiceover.
4. **Zernio video upload returned 400.** Presign payload used `fileName` / `fileType`. Server validated `filename` / `contentType`.
5. **Narrator and Dossie's voice playing simultaneously.** First attempt at a morning_brief screen-audio mix put the narrator at 100% and Dossie at 30% concurrently — they fought each other and neither was clear.
6. **Black bars top + bottom on b-roll.** Landscape clips letterboxed into a 9:16 frame instead of scale-to-fill + top-anchor crop.
7. **Screen recording cropped to square on the square render.** Mobile vertical recording was being chopped to 1080×1080 square, cutting the bottom of the UI.
8. **Sad / hunched / looking-down b-roll.** Pexels queries pulled clips of women looking down at desks, hunched over. Tone read as sad/stressed instead of confident.
9. **Voiceover script for narrator written as the full Morning Brief.** When the narrator's window was shortened to just the b-roll segment, the script was too long and would cut mid-sentence.

### Permanent fixes (RENDER_RULES enforced in code)

| # | Rule | Implementation |
|---|------|----------------|
| 1 | No black bars ever on b-roll | `render_broll_segment` uses an aspect-aware scale where landscape clips get `scale=-2:H` (height fills, width overshoots) and portrait clips get `scale=W:-2` (width fills). Both then top-anchor crop to (W, H). Validation: each rendered b-roll segment is probed for letterbox bars before mux. |
| 2 | Pexels quality filter | `gather_broll_candidates` rejects any clip with `width < 1080`, drops candidates whose query/url/tags contain blocklisted terms (sad, stressed, worried, sleeping, down, hunched), and prefers `is_portrait=true` strictly. The blocklist is `PEXELS_TONE_BLOCKLIST`. |
| 3 | morning_brief audio: narrator and Dossie never overlap; closing line in outro | `render_morning_brief_audio` builds a 4-segment mix. PART 1 narrator runs only during the b-roll window. PART 4 closing line ("This is what $29 a month sounds like. meetdossie.com/founding") is synthesized as a separate ElevenLabs call and placed in the outro window. Music ducks to 4% during the screen segment. |
| 4 | No mid-sentence cutoffs | Before final synth for morning_brief, `truncate_script_to_fit_duration` measures the full voiceover, computes the b-roll-segment budget in characters, and truncates the script at the LAST complete-sentence boundary that fits. Then re-synth produces the final narrator audio. |
| 5 | Screen recording display rules | Mobile portrait recordings: scale-to-fill width with top-anchor crop (preserves heads + UI top, no bars). Desktop landscape recordings: blush-bar (#F5E6E0) letterbox. Detected by aspect ratio of input file. |
| 6 | Video length 30–60s | `validate_render_rules` checks `30 <= total_seconds <= 60` and raises before final encode. If voiceover is shorter than 25s, `derive_segment_durations` extends the outro to fill. If voiceover is longer than 55s, the script is sentence-truncated before synth. |

### Validation — runs before final encode

`validate_render_rules(metadata)` raises if any rule is violated:
- `total_seconds` outside [30, 60]
- Any b-roll segment has > 5px of solid black at top OR bottom edge (heuristic — frame-1 sample)
- For morning_brief: narrator audio measured ≥ b-roll window duration (would imply mid-sentence cutoff)
- For morning_brief: closing line audio missing
- Screen recording aspect doesn't match expected handler (portrait→fill OR landscape→blush)

Failed validation aborts the render before the final mux, so no broken file is ever written to `Media/finished-videos/`.
