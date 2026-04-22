# ElevenLabs API Setup for Dossie Voice

Dossie uses ElevenLabs (Luna voice) for natural speech.

## Get API Key

1. Go to https://elevenlabs.io/
2. Sign in or create account
3. Go to Profile → API Keys
4. Copy your API key

## Add to Vercel

### Via CLI:

```bash
cd "C:\Users\Heath Shepard\Desktop\MeetDossie"
vercel env add ELEVENLABS_API_KEY
```

When prompted:
- **Value:** Paste your ElevenLabs API key
- **Environments:** Select all (Production, Preview, Development)

### Via Dashboard:

1. Go to https://vercel.com/heathshepard-6590s-projects/meet-dossie/settings/environment-variables
2. Click "Add New"
3. Key: `ELEVENLABS_API_KEY`
4. Value: Your ElevenLabs API key
5. Environments: Check all three boxes
6. Click Save

## Verify

After adding the key, test the `/api/speak` endpoint:

```bash
curl -X POST https://meetdossie.com/api/speak \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello, I am Dossie"}' \
  --output test.mp3
```

Should return an MP3 file with Luna's voice.

## Voice Settings

- **Voice:** Luna (ID: 6rOxfAnZpbM3VIEhFaeV)
- **Model:** eleven_turbo_v2 (fastest, lowest latency)
- **Stability:** 0.5
- **Similarity Boost:** 0.75
- **Style:** 0.0
- **Speaker Boost:** true

## Cost Estimate

ElevenLabs pricing (Creator plan):
- ~$0.30 per 1000 characters
- Average response: 200 characters = $0.06
- 200 messages/day (Solo plan) = ~$12/month per active user

Much higher quality than browser TTS, worth the cost for premium UX.
