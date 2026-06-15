# Talking-Head + Screen-Background Video Workflow

Turnkey pipeline for vertical social videos where Heath is the on-camera talking head over a Dossie screen recording, with auto Hormozi-style karaoke captions and a music bed underneath. Vertical 1080×1920, 30 fps, 3–60 seconds, post-ready for IG / TikTok / FB / X / LinkedIn.

Owner: **Atlas** (Head of Platform Engineering, Shepard Ventures)
Script: `MeetDossie/scripts/generate-talking-head-video.js`

---

## What Heath needs to do (the green-screen recording)

### 1. Build the green backdrop (one-time, 5 min)

Anything solid, non-shiny, and *true green* works. Cheapest options that look fine in the final composite:

- A green bedsheet thumbtacked flat to the wall behind the desk chair
- 2–3 sheets of bright green poster board / construction paper taped flush
- A retractable green-screen pull-up (Amazon, ~$30 — only worth it if Heath records weekly)

Hard rules:

- **Color: bright "chroma" green** (close to `#00FF00`). Avoid forest green, olive, or any shade with blue in it — the keyer will leave halos.
- **Flat and wrinkle-free.** Wrinkles cast shadows, and shadows survive the chroma key. A few wrinkles are fine; a crumpled sheet is not.
- **At least 18 inches behind Heath.** Distance prevents green light from spilling onto his shirt/neck (the keyer eats green skin).

### 2. Lighting (matters more than the camera)

- Two light sources on Heath's face, one on each side, slightly above. Window light + a desk lamp is plenty.
- A third light (any lamp) aimed *at the green backdrop*, not at Heath. Evenly lit green = a clean key.
- Avoid wearing green or anything with bright green logos. Bright reflective accents are also dangerous (think shiny lapel pins).

### 3. Record on your phone

- Vertical orientation (portrait).
- Camera ~chest-level, framing Heath from mid-chest up.
- 30–55 seconds per clip is the sweet spot.
- One take. Don't fuss with edits — captions cover small flubs and the pipeline ignores leading/trailing silence inside reason.

### 4. Drop the file for processing

Two ways:

**A. Telegram drop (recommended).**
1. AirDrop / save the recording to Heath's Desktop.
2. Drag the `.mp4` into a Telegram chat with **Claudy**.
3. Caption it: `talking head video screen=pipeline-view-desktop-2026-06-12.mp4`
   (the `screen=` portion is optional — Cole will pick a recent screen recording if you don't specify).
4. Cole runs the script, comes back with the finished video for approval.

**B. Manual CLI.**
```powershell
node "C:\Users\Heath Shepard\Desktop\MeetDossie\scripts\generate-talking-head-video.js" `
  --selfie "C:\Users\Heath Shepard\Desktop\heath-takes-2.mp4" `
  --screen pipeline-view-desktop-2026-06-12.mp4 `
  --caption "Your TC quit. Dossie picks up the file. Texas agents - meetdossie.com" `
  --telegram
```

---

## What the script does (the 5 stages)

| Stage | What runs | What it produces |
|---|---|---|
| **1. ffmpeg chroma + composite** | local `ffmpeg` with `chromakey` filter | one 1080×1920 MP4 with the green stripped and the selfie overlaid on the screen recording |
| **2. Whisper transcription** | OpenAI `whisper-1` (`verbose_json`, word timestamps) | word list with start/end timing for captions. *Skipped if `--script` is provided.* |
| **3. Supabase upload** | composite MP4 + music MP3 → `social-cards` bucket (public) | publicly-fetchable URLs Creatomate can pull |
| **4. Creatomate render** | one source-JSON render call (no template — we pass full element list inline) | finished MP4 with bold yellow karaoke captions on the bottom third and music ducked to ~10% under the voice |
| **5. Deliver** | download to `Media/finished-videos/`, insert `video_library` row, ping Heath via Claudy on Telegram | `talking-head-YYYY-MM-DD-<slug>.mp4` ready to publish |

---

## CLI reference

```
node scripts/generate-talking-head-video.js \
  --selfie  <path-to-green-screen.mp4>            REQUIRED
  --screen  <path or filename in Media/screen-recordings/>   REQUIRED
  [--script "voiceover text"]                     skip Whisper, pass transcript
  [--script-file path.txt]                        same, from a file
  [--music path.mp3]                              override default music bed
  [--caption "social caption"]                    appears in Telegram approval msg
  [--slug talking-head-test]                      filename suffix; default = selfie name
  [--telegram]                                    ping Claudy when done
  [--keep-temp]                                   don't delete tmp dir (debugging)
```

Required env (read from `MeetDossie/.env.local`):

- `CREATOMATE_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (uploads)
- `OPENAI_API_KEY` (only if no `--script`)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (only if `--telegram`)

---

## Architectural choices (so the next engineer doesn't second-guess)

**Why ffmpeg locally instead of Creatomate's built-in chroma?**
Creatomate's public docs (as of 2026-06-15) do not expose a documented green-screen / chroma-key property on video elements. Tested two probes against `api.creatomate.com/v1/renders` — neither schema reference (`color_overlay`, `chroma_key`) is acknowledged. Going through ffmpeg locally gives:
- Pixel-level control of similarity + blend (Heath's lighting won't be studio-perfect)
- Zero per-frame Creatomate cost on the chroma stage
- Predictable output dimensions before the network call

**Why use Whisper for word timing instead of Creatomate's "karaoke text" template?**
Creatomate karaoke templates need a pre-formatted SRT or `transcript_source` plus a configured template. Spawning per-word text elements with explicit `time` + `duration` is simpler, render-deterministic, and lets us swap caption styles without redoing a template.

**Why upload the composite to Supabase Storage instead of streaming bytes to Creatomate?**
Creatomate's `source` JSON requires public URLs. Reusing the existing `social-cards` bucket (already public-read, already used by `generate-creatomate-video.py`) avoids new IAM work.

**Why one render call instead of multiple?**
Cost. Each Creatomate render is billed by output duration. Doing the chroma + composite locally and only calling Creatomate once for captions + music = one billable render per finished video.

---

## Known limitations / tech debt

- **render_scale on free tier.** If the Creatomate account is on the dev plan, the API returns videos at 25 % scale (270×480). Test renders display the warning. Upgrade Creatomate to a paid plan before relying on this for customer-facing videos. Script flags this in the Telegram caption when it happens.
- **Whisper word boundary occasionally clips short words.** "I'll" / "you're" sometimes show twice. Acceptable for v1; revisit if Heath complains.
- **No per-platform export.** This produces ONE vertical MP4 suitable for IG Reel / TikTok / Shorts / FB Reel / LinkedIn vertical / X vertical. If Heath needs a horizontal cut later, that's a separate pipeline (existing `generate-creatomate-video.py`).
- **No b-roll inserts.** Pure talking head + screen recording. If we want zoom-ins, jump-cuts, or stock b-roll, layer that in v2 — the architecture supports more `track` indices.

---

## File index (everything this pipeline touches)

| Path | Purpose |
|---|---|
| `MeetDossie/scripts/generate-talking-head-video.js` | the pipeline |
| `MeetDossie/scripts/TALKING-HEAD-WORKFLOW.md` | this doc |
| `MeetDossie/Media/screen-recordings/` | source screen recordings |
| `MeetDossie/Media/screen-recordings/LIBRARY.md` | screen recording catalog |
| `MeetDossie/Media/Music/joyinsound-corporate-motivational-background-music-403417.mp3` | default music bed |
| `MeetDossie/Media/finished-videos/` | output destination |
| `MeetDossie/.env.local` | API keys |
| Supabase bucket `social-cards` | intermediate composite + music URL hosting |
| Supabase table `video_library` | render log |
