// api/_utils/tts.js
// Shared TTS helper: tries ElevenLabs first, falls back to OpenAI on failure.
//
// Usage:
//   const { generateSpeech } = require('../_utils/tts');
//   const { buffer, provider } = await generateSpeech(text, {
//     elevenLabsVoiceId: 'lxYfHSkYm1EzQzGhdbfc',
//     persona: 'luna',           // 'luna' or 'bill'
//     elevenLabsModelId: 'eleven_turbo_v2_5',  // optional
//     voiceSettings: { ... },    // optional ElevenLabs voice_settings override
//   });
//   // buffer: Buffer of MP3 audio data
//   // provider: 'elevenlabs' | 'openai'

// OpenAI voice mapping — closest perceptual match to each ElevenLabs persona.
const OPENAI_VOICE_MAP = {
  luna:   'nova',   // warm female
  bill:   'onyx',   // clear male
  // Ventures agents fallback to closest match
  cole:   'onyx',
  hadley: 'nova',
  pierce: 'echo',
  atlas:  'onyx',
  carter: 'echo',
  sage:   'nova',
};

async function generateSpeech(text, options = {}) {
  const {
    elevenLabsVoiceId,
    persona = 'luna',
    elevenLabsModelId = 'eleven_turbo_v2_5',
    voiceSettings = { stability: 0.5, similarity_boost: 0.75 },
  } = options;

  // Try ElevenLabs first when both key and voice ID are available.
  if (process.env.ELEVENLABS_API_KEY && elevenLabsVoiceId) {
    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${elevenLabsVoiceId}`,
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
      console.warn(
        `[tts] ElevenLabs failed (${res.status}) — falling back to OpenAI`
      );
    } catch (e) {
      console.warn('[tts] ElevenLabs error — falling back to OpenAI:', e.message);
    }
  }

  // OpenAI TTS fallback.
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('TTS unavailable: ELEVENLABS_API_KEY and OPENAI_API_KEY both missing or failed');
  }

  const openaiVoice = OPENAI_VOICE_MAP[persona] || OPENAI_VOICE_MAP[persona.toLowerCase()] || 'nova';

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1-hd',
      input: text,
      voice: openaiVoice,
      response_format: 'mp3',
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>');
    throw new Error(`OpenAI TTS failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, provider: 'openai' };
}

module.exports = { generateSpeech, OPENAI_VOICE_MAP };
