# PlayHT Voice Mapping (Dossie ↔ PlayHT)

PlayHT is the new primary TTS provider (ElevenLabs deprecated due to the 2026-06 forced-renewal billing).
Each Dossie persona maps to one PlayHT prebuilt voice. The `voice` parameter for the PlayHT2.0 engine
is the **full s3 manifest URL** in the form:

`s3://voice-cloning-zero-shot/<voice-uuid>/<voice-slug>/manifest.json`

Engine: `PlayHT2.0` (slower but higher quality than 1.0; supports `emotion`, `voice_guidance`, `style_guidance`).

---

## Mapping (final picks)

| Dossie persona | Old ElevenLabs voice ID | PlayHT voice name | PlayHT voice ID (uuid) | PlayHT voice param (s3 URL) | Style notes |
|---|---|---|---|---|---|
| **Bill** (mature, authoritative male narrator — Morning Brief for Victor, Ventures voice for Cole/Atlas) | `pqHfZKP75CvOlQylNhV4` | William (Narrative) | `688d0200-7415-42b4-8726-e2f5693aaac8` | `s3://voice-cloning-zero-shot/688d0200-7415-42b4-8726-e2f5693aaac8/william/manifest.json` | American, narrative style, neutral settings — confident news-anchor feel |
| **Luna** (warm, conversational female — Morning Brief for Brenda/Patricia, Sage/Hadley Ventures voice) | `lxYfHSkYm1EzQzGhdbfc` | Delilah | `1afba232-fae0-4b69-9675-7f1aac69349f` | `s3://voice-cloning-zero-shot/1afba232-fae0-4b69-9675-7f1aac69349f/delilah/manifest.json` | American, narrative, slow tempo, smooth — warm podcast-host feel |
| **Charlie** (energetic, relatable female — selfie videos, social reels) | (ElevenLabs Charlie) | Ariana | (uuid TBD on real catalog lookup) | `s3://voice-cloning-zero-shot/<ariana-uuid>/ariana/manifest.json` | American, "youth" age, "high" loudness, videos style — TikTok/Reels energy |

> **Charlie's exact UUID needs confirmation against the live PlayHT voice list once we have the API key.**
> Fall-back if Ariana sounds off: **Phoebe** (American, high loudness, videos style — same upbeat/social-media bucket).

---

## Env vars (Vercel + .env.local)

```
PLAYHT_USER_ID=<from play.ht/studio/api-access>
PLAYHT_API_SECRET=<from play.ht/studio/api-access>
PLAYHT_VOICE_BILL=s3://voice-cloning-zero-shot/688d0200-7415-42b4-8726-e2f5693aaac8/william/manifest.json
PLAYHT_VOICE_LUNA=s3://voice-cloning-zero-shot/1afba232-fae0-4b69-9675-7f1aac69349f/delilah/manifest.json
PLAYHT_VOICE_CHARLIE=s3://voice-cloning-zero-shot/<TBD>/ariana/manifest.json
TTS_PROVIDER=playht   # playht (default) | elevenlabs (legacy) | openai (fallback)
```

---

## Runner-up candidates (use if the picks above sound wrong on first listen)

**Bill (mature male narrator):**
- William (Narrative) — `688d0200-7415-42b4-8726-e2f5693aaac8` ← current pick
- Charles — `9f1ee23a-9108-4538-90be-8e62efc195b6` — narrative, neutral, round texture
- Samuel — `36e9c53d-ca4e-4815-b5ed-9732be3839b4` — narrative, slow, gravelly (oldest sounding)
- Adolfo — `d82d246c-148b-457f-9668-37b789520891` — narrative, fast tempo, thick texture

**Luna (warm female conversational):**
- Delilah — `1afba232-fae0-4b69-9675-7f1aac69349f` ← current pick
- Nova — `2a7ddfc5-d16a-423a-9441-5b13290998b8` — narrative, whisper loudness (very soft — only if Delilah is too neutral)

**Charlie (energetic female):**
- Ariana — `<TBD>` ← current pick (youth-tagged)
- Phoebe — `<TBD>` (videos style, high loudness)
- Susan (Advertising) — `f6594c50-e59b-492c-bac2-047d57f8bdd8` (advertising tag — if we need ad-read energy)

---

## API quick-reference (for the helper module)

**Auth headers (case-sensitive):**
```
AUTHORIZATION: <PLAYHT_API_SECRET>
X-USER-ID: <PLAYHT_USER_ID>
accept: application/json
content-type: application/json
```

**Create TTS job:** `POST https://api.play.ht/api/v2/tts` →
```json
{
  "text": "...",
  "voice": "s3://voice-cloning-zero-shot/.../manifest.json",
  "voice_engine": "PlayHT2.0",
  "output_format": "mp3",
  "quality": "premium",
  "speed": 1.0,
  "sample_rate": 24000
}
```
Returns 201 with `Location: /api/v2/tts/<id>` header.

**Poll job:** `GET https://api.play.ht/api/v2/tts/<id>` →
- `output.url` is the final mp3 once `output` is populated. Poll every ~1.5s up to ~45s.

**Iteration log:** if Heath says a voice is wrong, update this file with new pick + reason, redeploy env var.
