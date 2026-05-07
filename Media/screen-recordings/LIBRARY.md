# Screen Recording Library

Catalog of mobile screen recordings used by `scripts/generate-lifestyle-video.py` as the middle segment of lifestyle videos. The renderer picks a recording by matching the `topic` slug against the filename prefix and validating the day's `persona` against the recording's gender pairing.

## Index

| Filename | Persona | Voice | Demo Account | Notes |
|---|---|---|---|---|
| morning-brief-mobile-2026-05-06.mp4 | brenda/patricia | Luna | Sarah Whitley (demo@) | Mobile, female demo account |
| trec-deadlines-mobile-2026-05-06.mp4 | brenda/patricia | Luna | Sarah Whitley (demo@) | Mobile, female demo account |
| pipeline-mobile-2026-05-06.mp4 | brenda/patricia | Luna | Sarah Whitley (demo@) | Mobile, female demo account |
| talk-to-dossie-mobile-2026-05-06.mp4 | victor | Bill | John Smith (demo2@) | Mobile, Heath as male agent talking to Dossie |

## Pairing Rule (NON-NEGOTIABLE)

`talk-to-dossie-mobile-2026-05-06.mp4` shows Heath on camera as a male agent talking to Dossie. It MUST ONLY be used with the **Victor** persona and the **Bill** voiceover. Never pair it with Brenda or Patricia content — the male agent on screen will not match a female voice persona.

The other three recordings (`morning-brief`, `trec-deadlines`, `pipeline`) show only the screen of the female demo account (Sarah Whitley). They MUST ONLY be used with female personas (Brenda or Patricia).

`scripts/generate-lifestyle-video.py` enforces this by reading the `Persona` column above and selecting only recordings whose persona list contains the day's persona. If no compatible recording exists for a (topic, persona) combination, the renderer falls back to b-roll filler for that segment rather than mismatch a recording.

## Platform Aspect Rule — derived from filename (NON-NEGOTIABLE)

Aspect and platform compatibility are **derived from the filename**, not a separate column. The form-factor segment (`mobile` vs `desktop`) is the single source of truth:

- `*-mobile-*.mp4` → portrait → eligible for **instagram, tiktok**
- `*-desktop-*.mp4` → landscape → eligible for **facebook, twitter, linkedin**

`select_screen_recording(topic, persona, platform)` filters by:
1. Filename starts with `<topic-slug>-`
2. `persona` is in the row's persona list (Persona column)
3. `platform` is in the platforms derived from the filename's form-factor

If any of those yields zero rows, the renderer returns None and falls back to b-roll filler — never a cross-aspect mismatch (a portrait mobile capture never lands in a Facebook square render).

When a desktop recording is added later, dropping `morning-brief-desktop-2026-05-07.mp4` into this folder + adding one row to the table is enough. The pipeline routes it to Facebook/Twitter automatically because the filename contains `desktop`.

## Naming Convention

`<topic-slug>-<form-factor>-<YYYY-MM-DD>.mp4`

- `topic-slug`: matches the topic key from `content_calendar.feature`, with underscores replaced by hyphens (e.g., `talk_to_dossie` → `talk-to-dossie`).
- `form-factor`: `mobile` (1080×1920 portrait) or `desktop` (landscape).
- `YYYY-MM-DD`: the date the recording was captured. When you re-record the same scene later, add a row to the table with the new date — the renderer sorts by filename descending and picks the newest match automatically.

## Adding a New Recording

1. Drop the MP4 into this directory using the naming convention above.
2. Add a row to the table with persona compatibility, voice, demo account, and any caveats.
3. Commit both the file and this LIBRARY.md update.
