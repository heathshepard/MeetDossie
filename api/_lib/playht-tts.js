// api/_lib/playht-tts.js
// PlayHT TTS helper. Single export: synthesize(text, options) -> { buffer, provider }
//
// PlayHT v2 TTS is async: POST creates a job, GET polls until output.url is populated.
// We download the final mp3 and return a Buffer to match the existing ElevenLabs
// helper interface so callers can swap providers without code changes.
//
// Env vars:
//   PLAYHT_USER_ID       — from play.ht/studio/api-access
//   PLAYHT_API_SECRET    — from play.ht/studio/api-access
//
// Voice resolution:
//   options.voiceId   — full s3://voice-cloning-zero-shot/.../manifest.json (preferred)
//   options.persona   — 'bill' | 'luna' | 'charlie' → resolves to PLAYHT_VOICE_<PERSONA> env

const PLAYHT_BASE = 'https://api.play.ht/api/v2';
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_ATTEMPTS = 40; // ~60s total — long brief audio takes 30-45s on PlayHT2.0

const PERSONA_ENV_VAR = {
  bill: 'PLAYHT_VOICE_BILL',
  luna: 'PLAYHT_VOICE_LUNA',
  charlie: 'PLAYHT_VOICE_CHARLIE',
};

function resolveVoice(options) {
  if (options.voiceId) return options.voiceId;
  const persona = (options.persona || '').toLowerCase();
  const envVar = PERSONA_ENV_VAR[persona];
  if (envVar && process.env[envVar]) return process.env[envVar];
  // No mapped PlayHT voice for this persona — return null so the provider
  // abstraction falls through to ElevenLabs or OpenAI.
  return null;
}

async function synthesize(text, options = {}) {
  const userId = process.env.PLAYHT_USER_ID;
  const apiSecret = process.env.PLAYHT_API_SECRET;

  if (!userId || !apiSecret) {
    throw new Error('[playht] PLAYHT_USER_ID or PLAYHT_API_SECRET not set');
  }

  const voice = resolveVoice(options);
  if (!voice) {
    throw new Error('[playht] No voice resolved — set voiceId, persona, or PLAYHT_VOICE_* env vars');
  }

  const body = {
    text,
    voice,
    voice_engine: options.voiceEngine || 'PlayHT2.0',
    output_format: options.outputFormat || 'mp3',
    quality: options.quality || 'premium',
    speed: typeof options.speed === 'number' ? options.speed : 1.0,
    sample_rate: options.sampleRate || 24000,
  };

  const createRes = await fetch(`${PLAYHT_BASE}/tts`, {
    method: 'POST',
    headers: {
      AUTHORIZATION: apiSecret,
      'X-USER-ID': userId,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!createRes.ok) {
    const detail = await createRes.text().catch(() => '<no body>');
    throw new Error(`[playht] create TTS failed (${createRes.status}): ${detail.slice(0, 300)}`);
  }

  const createData = await createRes.json().catch(() => null);
  const jobId =
    (createData && (createData.id || createData.transcriptionId)) ||
    (createRes.headers.get('location') || '').split('/').pop();

  if (!jobId) {
    throw new Error('[playht] could not extract job id from create response');
  }

  // Poll
  let attempt = 0;
  let outputUrl = null;
  while (attempt < POLL_MAX_ATTEMPTS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    attempt += 1;

    const pollRes = await fetch(`${PLAYHT_BASE}/tts/${jobId}`, {
      headers: {
        AUTHORIZATION: apiSecret,
        'X-USER-ID': userId,
        accept: 'application/json',
      },
    });

    if (!pollRes.ok) {
      // 404 right after create is normal for a beat — keep polling
      if (pollRes.status === 404 && attempt < 3) continue;
      const detail = await pollRes.text().catch(() => '<no body>');
      throw new Error(`[playht] poll failed (${pollRes.status}): ${detail.slice(0, 200)}`);
    }

    const pollData = await pollRes.json().catch(() => null);
    if (pollData && pollData.output && pollData.output.url) {
      outputUrl = pollData.output.url;
      break;
    }
    if (pollData && pollData.error) {
      throw new Error(`[playht] job error: ${JSON.stringify(pollData.error).slice(0, 300)}`);
    }
  }

  if (!outputUrl) {
    throw new Error(`[playht] timed out after ${attempt} polls (~${(POLL_INTERVAL_MS * attempt) / 1000}s)`);
  }

  const audioRes = await fetch(outputUrl);
  if (!audioRes.ok) {
    throw new Error(`[playht] mp3 download failed (${audioRes.status})`);
  }
  const buffer = Buffer.from(await audioRes.arrayBuffer());
  return { buffer, provider: 'playht' };
}

module.exports = { synthesize };
