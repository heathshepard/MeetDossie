# Quinn -> Carter: /api/speak 500 — Dossie has no voice in production

**Severity:** CRITICAL — Dossie's defining feature (voice) does not work.

## Bug

`POST /api/speak` returns 500 on every call in production.

Direct repro (no auth needed — speak.js doesn't check JWT):
```bash
curl -X POST https://meetdossie.com/api/speak \
  -H "Content-Type: application/json" -H "Origin: https://meetdossie.com" \
  -d '{"text":"This is Dossie.","speed":1.0}'
# → 500 {"ok":false,"error":"Failed to generate speech"}
```

## End-user impact

- Voice call mode opens, listens, fails silently. Console: `[Jessica] audio failed, continuing loop silently`
- Morning Brief audio: "Play Brief" does nothing — speak 500s on every play
- Every voice-mode-fed Talk-to-Dossie answer is silent

Dossie's voice IS the product. This kills the demo.

## Root cause

`api/_utils/tts.js` tries 3 providers in order:
1. Primary chosen by `TTS_PROVIDER` env var. Default is **playht**.
2. Then the other two as fallbacks.

CLAUDE.md tech stack only references **ElevenLabs** (Bill + Luna) and OpenAI as fallback. PlayHT is not in our stack.

If `PLAYHT_*` env vars are missing in Vercel, the chain falls through to ElevenLabs and OpenAI. For the chain to fail completely, ALL three providers must fail. Possible reasons:
- ElevenLabs voice IDs invalid / API key expired / monthly credit exhausted
- OpenAI key missing or quota exceeded
- `TTS_PROVIDER` set to a bad value

The 500 returns a flat "Failed to generate speech" with no provider attribution — Carter has no signal which provider failed.

## Fix (5 minutes)

1. Set `TTS_PROVIDER=elevenlabs` in Vercel env (production AND staging). PlayHT default is wrong for us.
2. Verify in Vercel dashboard:
   - `ELEVENLABS_API_KEY` is present and non-empty
   - It's the **Creator-plan** key (per CLAUDE.md, $18.33/mo upgraded 2026-05-19)
   - Voice IDs in `tts.js` match real ElevenLabs voices in Heath's account: Bill `pqHfZKP75CvOlQylNhV4`, Luna `lxYfHSkYm1EzQzGhdbfc`
3. Quick check on ElevenLabs dashboard: 30k/mo credits remaining? Any 429 / 401 from their side?
4. Add structured server-side logging in `api/speak.js`:
```js
} catch (error) {
  console.error('[speak] ALL TTS providers failed', {
    primaryProvider: PROVIDER,
    elevenlabsKeySet: !!process.env.ELEVENLABS_API_KEY,
    openaiKeySet: !!process.env.OPENAI_API_KEY,
    textLength: text?.length || 0,
    errorMsg: error.message,
  });
}
```
5. Add provider attribution to client error response (200 with `provider: 'fallback-text'` is OK; 500 with sanitized "voice unavailable" is OK).

## How to verify

After fix, on staging:
```bash
curl -X POST https://meet-dossie-<hash>.vercel.app/api/speak \
  -H "Content-Type: application/json" -H "Origin: https://meetdossie.com" \
  -d '{"text":"This is Dossie.","speed":1.0}' --output speak.mp3
file speak.mp3   # should say "MPEG ADTS audio"
```

Then on production after merge:
```bash
curl -X POST https://meetdossie.com/api/speak \
  -H "Content-Type: application/json" -H "Origin: https://meetdossie.com" \
  -d '{"text":"This is Dossie.","speed":1.0}' --output speak.mp3
# Should be > 5KB MP3
```

Live UI test:
1. Sarah Whitley demo → Play Brief → audio plays
2. Voice Call → speak the morning brief → audio plays

## Why this matters

Heath's pitch is "warm professional Texas TC who speaks like a real colleague." Without voice, she's a chat UI — same as ChatGPT, ZipForms, any other generic tool. The whole positioning crumbles.

Voice + Talk-to-Dossie + draft-amendment is the demo. All three are currently dead. The 401 (spec #1) and dispatcher (spec #2) and speak (this spec) are the trio that need to ship together to bring Dossie back to life.
