# Video Rules

## SCREEN RECORDING NAMING CONVENTION

```
<topic-slug>-mobile-<YYYY-MM-DD>.mp4   → portrait → IG, TikTok
<topic-slug>-desktop-<YYYY-MM-DD>.mp4  → landscape → FB, Twitter, LinkedIn
```

`mobile`/`desktop` segment = single source of truth for platform routing (`derive_aspect_and_platforms_from_filename()` in `generate-lifestyle-video.py`). One row per recording in `Media/screen-recordings/LIBRARY.md`. Never overwrite — append date/counter on collision. Read LIBRARY.md before selecting.

---

## VIDEO PIPELINE RULES (summary)

Source of truth: `RENDER_RULES` block in `scripts/generate-lifestyle-video.py` + `RENDER_FEEDBACK_LOG.md`. Read both before touching the renderer.

- Never resize aspect ratios; portrait→vertical, landscape→square.
- Never letterbox/black-bar; scale-to-fill + top-anchor crop.
- `morning_brief`: 3-layer audio (narrator→sample brief→close), ~44s. All others: continuous narrator.
- Duration 30-60s (validator aborts outside).
- Voice from `LIBRARY.md`; never hardcode Bill/Luna.
- Pexels: blocklist sad/stressed/worried/sleeping/down/hunched, min width 1080.
- Screen-rec trim: `max(freeze_end, silence_end)`.

---

## CONTENT CALENDAR STRUCTURE

- 25 rows (5 weeks × 5 days). Wk1 feature-demo, Wk2 pain-point, Wk3 founder-leaning, Wk4 founder-story, Wk5 control-freak agent (Brittney).
- Personas: brenda (9), patricia (6), victor (10). Voiceover scripts 408–565 chars.
- **Timeframe:** never "a few months ago" — use "recently" / "over the last few weeks".
- **Social proof:** no unverified stats; numbers framed as hypotheticals.
- **Hashtags:** IG 8-10, FB 0, Twitter 2-3, LinkedIn 3-5.

---

## VIDEO CONTENT RULES (voiceover scripts)

- **Opening:** specific pain point, not generic. WRONG "Managing transactions is hard." RIGHT "Your TC calls you at 8AM asking which title company to use."
- **Tone:** conversational, not corporate. **Rhythm:** short punchy sentences at end build momentum.
- **Persona voice:** Victor = authoritative volume (confident/direct). Brenda = emotional relatable (warm/empathetic). Patricia = practical part-time (efficient/time-focused).
- **Inflection:** no rising endings. Period-heavy short closes.
- **Duration:** 35-45s at natural pace.
- **Closing:** end with "This is Dossie." then CTA "Texas agents — meetdossie.com slash founding."

---

## POSTING SCHEDULE

Caps enforced in `posting_schedule` DB table; TikTok posts park as `pending_video` until DONE pipeline attaches a video.

| Platform | Slots (CST) | Cap |
|---|---|---|
| Facebook | 9AM, 6PM | 2/day |
| Twitter | 8AM, 12PM, 4PM | 3/day |
| Instagram | 8AM, 6PM | 1/day |
| LinkedIn | 7AM, 12PM | 1/day |
| TikTok | 7AM, 7PM | 1/day (ACTIVE - video required via DONE pipeline) |

**Daily generation target: 8 posts** (2 Facebook, 3 Twitter, 1 Instagram, 1 LinkedIn, 1 TikTok)

---

## CONTENT ENGINE DAILY WORKFLOW

1. 9AM CST weekdays: Claudy sends daily brief (platform/hook/script/demo account/filename) to Telegram.
2. Heath records ~10min, saves to `Media\screen-recordings\` with exact filename.
3. Heath replies **DONE** to Claudy.
4. Claude Code runs `generate-creatomate-video.py`: upload to Supabase Storage → Creatomate template `791117d0-665c-4cd0-ba5f-a767f8921f9b` (voiceover/URL/persona/caption) → poll → URL.
5. Video → DossieMarketingBot for approval → social posts.

Separately: DossieMarketingBot sends draft social posts all day for Approve/Reject.

---

## MEDIA FOLDER STRUCTURE

```
MeetDossie\Media\
├── screen-recordings\   (+ LIBRARY.md — always read before touching recordings)
├── finished-videos\
├── voiceovers\
├── b-roll\[topic]\
├── instagram-cards\
├── music\
└── screen-shots\
```
