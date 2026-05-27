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
| 7 | Platform ↔ aspect mapping (NON-NEGOTIABLE) | `PLATFORM_TO_ASPECT` maps `instagram/tiktok → vertical 1080×1920` and `facebook → square 1080×1080`. Pexels searches are per-aspect: vertical uses portrait sources, square uses landscape sources (center-cropped). Screen recording aspect/platforms are **derived from filename** via `derive_aspect_and_platforms_from_filename()`: `*-mobile-*.mp4` → portrait → instagram/tiktok; `*-desktop-*.mp4` → landscape → facebook/twitter/linkedin. `select_screen_recording(topic, persona, platform)` filters by the derived platforms — cross-aspect pairings return None → b-roll filler. |

## 2026-05-07 — platform/aspect mismatch rule

### Issue found

10. **Risk of cross-aspect screen recordings.** The selector matched LIBRARY.md rows by topic + persona only. A vertical (mobile portrait) recording could be paired with a square Facebook render, producing letterbox bars where the recording would be downscaled. Conversely a future landscape desktop recording would have been used in an Instagram Reel.

### Permanent fix

`select_screen_recording(topic, persona, platform)` now requires the platform to be in the recording's platforms list. The aspect (portrait/landscape) and platforms (instagram/tiktok vs facebook/twitter/linkedin) are derived from the filename's form-factor segment via `derive_aspect_and_platforms_from_filename()`:

- `*-mobile-*.mp4` → portrait → instagram, tiktok
- `*-desktop-*.mp4` → landscape → facebook, twitter, linkedin

When Heath records a desktop screen recording, dropping `morning-brief-desktop-2026-05-07.mp4` into `Media/screen-recordings/` and adding one row to LIBRARY.md is enough — the pipeline routes it to Facebook automatically because the filename contains `desktop`. No manual platform tagging needed.

### Validation — runs before final encode

`validate_render_rules(metadata)` raises if any rule is violated:
- `total_seconds` outside [30, 60]
- Any b-roll segment has > 5px of solid black at top OR bottom edge (heuristic — frame-1 sample)
- For morning_brief: narrator audio measured ≥ b-roll window duration (would imply mid-sentence cutoff)
- For morning_brief: closing line audio missing
- Screen recording aspect doesn't match expected handler (portrait→fill OR landscape→blush)

Failed validation aborts the render before the final mux, so no broken file is ever written to `Media/finished-videos/`.

## 2026-05-26 — black screen at start of TikTok video

### Issue found

11. **14-second black screen at the start of trec-deadlines-desktop-2026-05-26-square.mp4** that posted to TikTok. Root cause: the Pexels b-roll clips rendered as black (either Pexels API returned black/corrupt clips or the b-roll ffmpeg pipeline failed silently), causing both the hook card (0-3s) AND the b-roll segment (3-14s) to render solid black. The screen recording segment started at 14s and showed valid Dossie UI content. The finished video had 14.17s of black confirmed by ffmpeg `blackdetect`. The source screen recording itself was fine — the issue was upstream in the b-roll stage.

### Fix applied (2026-05-26)

- `SCREEN_TRIM_MAX` raised from 8.0 to 30.0 — belt-and-suspenders in case of any future dead-air in screen recordings.
- `detect_freeze_at_start()` restored to first-freeze-window-only behavior with clear comment explaining why chaining windows is wrong for compressed screen captures.
- New `detect_black_at_start()` function added as primary dead-air detector — uses `blackdetect` which is more reliable than freezedetect for near-black loader screens.
- `trim_screen_recording()` updated to run black detection first, freeze detection second, silence detection third, and take the MAX.
- **Hotfix for posted video:** `trec-deadlines-desktop-2026-05-26-square.mp4` trimmed at 14.167s via ffmpeg and re-uploaded to Supabase Storage as `trec-deadlines-desktop-2026-05-26-square-v2.mp4`. `video_library.supabase_url` updated. Fixed video is 16.57s of clean Dossie dashboard content.
- **TODO:** Add post-render blackdetect validation — if the first 5s of the finished video is >80% black, abort and alert Heath rather than posting silently.
