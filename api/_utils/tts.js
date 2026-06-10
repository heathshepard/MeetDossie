// api/_utils/tts.js
// Provider-abstracted TTS helper.
//
// Order of operations:
//   1. TTS_PROVIDER env var picks the primary provider (default: 'playht').
//      Allowed values: 'playht' | 'elevenlabs' | 'openai'.
//   2. If the primary provider fails (network, quota, missing keys), fall back
//      to OpenAI Nova/Onyx (last-resort never-fail path).
//
// Backward-compatible signature — existing callers do not need to change:
//   const { generateSpeech } = require('../_utils/tts');
//   const { buffer, provider } = await generateSpeech(text, {
//     elevenLabsVoiceId: 'lxYfHSkYm1EzQzGhdbfc',
//     persona: 'luna',
//     elevenLabsModelId: 'eleven_turbo_v2_5',
//     voiceSettings: { ... },
//     // New (optional):
//     playhtVoiceId: 's3://voice-cloning-zero-shot/.../manifest.json',
//   });
//   // provider: 'playht' | 'elevenlabs' | 'openai'

const { synthesize: playhtSynthesize } = require('../_lib/playht-tts');

const PROVIDER = (process.env.TTS_PROVIDER || 'playht').toLowerCase();

// OpenAI voice mapping — closest perceptual match to each Dossie persona.
const OPENAI_VOICE_MAP = {
  luna:    'nova',
  bill:    'onyx',
  charlie: 'shimmer',
  // Ventures agents
  cole:    'onyx',
  hadley:  'nova',
  pierce:  'echo',
  atlas:   'onyx',
  carter:  'echo',
  sage:    'nova',
};

async function tryPlayHT(text, options) {
  if (!process.env.PLAYHT_USER_ID || !process.env.PLAYHT_API_SECRET) {
    return null;
  }
  // Skip silently if the persona has no PlayHT voice mapping AND no explicit
  // voiceId was passed — this lets Ventures agents (cole/atlas/etc.) flow
  // straight to ElevenLabs without noisy warnings.
  const personaKey = (options.persona || '').toLowerCase();
  const personaEnvVar = { bill: 'PLAYHT_VOICE_BILL', luna: 'PLAYHT_VOICE_LUNA', charlie: 'PLAYHT_VOICE_CHARLIE' }[personaKey];
  const hasMappedVoice = options.playhtVoiceId || (personaEnvVar && process.env[personaEnvVar]);
  if (!hasMappedVoice) return null;
  try {
    return await playhtSynthesize(text, {
      voiceId: options.playhtVoiceId,
      persona: options.persona,
    });
  } catch (e) {
    console.warn('[tts] PlayHT error — falling through:', e.message);
    return null;
  }
}

async function tryElevenLabs(text, options) {
  const voiceId = options.elevenLabsVoiceId;
  if (!process.env.ELEVENLABS_API_KEY || !voiceId) {
    return null;
  }
  const {
    elevenLabsModelId = 'eleven_turbo_v2_5',
    voiceSettings = { stability: 0.5, similarity_boost: 0.75 },
  } = options;
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: elevenLabsModelId,
          voice_settings: voiceSettings,
        }),
      }
    );
    if (res.ok) {
      const buffer = Buffer.from(await res.arrayBuffer());
      return { buffer, provider: 'elevenlabs' };
    }
    console.warn(`[tts] ElevenLabs failed (${res.status}) — falling through`);
    return null;
  } catch (e) {
    console.warn('[tts] ElevenLabs error — falling through:', e.message);
    return null;
  }
}

async function tryOpenAI(text, options) {
  if (!process.env.OPENAI_API_KEY) return null;
  const persona = (options.persona || 'luna').toLowerCase();
  const openaiVoice = OPENAI_VOICE_MAP[persona] || 'nova';
  
  // OpenAI tts-1-hd doesn't support SSML. Strip all break tags and replace with ellipsis pauses.
  const cleanedText = text
    .replace(/<break\s+time=["']?\d+ms["']?\s*\/?>/g, '... ')
    .replace(/<[^>]+>/g, ''); // Remove any other XML-like tags as fallback
  
  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1-hd',
        input: cleanedText,
        voice: openaiVoice,
        response_format: 'mp3',
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '<no body>');
      console.warn(`[tts] OpenAI failed (${res.status}): ${detail.slice(0, 200)}`);
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, provider: 'openai' };
  } catch (e) {
    console.warn('[tts] OpenAI error:', e.message);
    return null;
  }
}

async function generateSpeech(text, options = {}) {
  // Provider order: primary chosen by TTS_PROVIDER, then the other two as fallbacks.
  const all = {
    playht: tryPlayHT,
    elevenlabs: tryElevenLabs,
    openai: tryOpenAI,
  };
  const order = [PROVIDER, ...Object.keys(all).filter((k) => k !== PROVIDER)];

  for (const name of order) {
    const fn = all[name];
    if (!fn) continue;
    const result = await fn(text, options);
    if (result) return result;
  }

  throw new Error('TTS unavailable: all providers (PlayHT, ElevenLabs, OpenAI) failed or unconfigured');
}

module.exports = { generateSpeech, OPENAI_VOICE_MAP };
