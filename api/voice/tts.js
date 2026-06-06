// /api/voice/tts — TTS proxy for Shepard Ventures agents.
// ElevenLabs primary, OpenAI TTS fallback when billing-blocked.
//
// Auth: Bearer <VOICE_INGEST_SECRET> shared with the local Claude Code hook.
// Body: { text: string, voice_id?: string, agent?: string }
// Response: audio/mpeg stream
//
// Owner: Atlas (SV-VOICE-001)

const { generateSpeech } = require('../_utils/tts');

const AGENT_VOICE_MAP = {
  // Canonical ElevenLabs default-library voice IDs.
  // Source: https://api.elevenlabs.io/v1/voices (default voices return same IDs across accounts).
  cole:    'IKne3meq5aSn9XLyUdCD', // Charlie — natural conversational American male, warm/soft
  hadley:  'XB0fDUnXU5powFXDhCwa', // Charlotte — calm English female, professional
  pierce:  'TxGEqnHWrfWFTfGW9XjX', // Josh — deep American male, warm
  atlas:   'nPczCjzI2devNBz1zQrb', // Brian — American male, deep / authoritative
};

const DEFAULT_VOICE_ID = AGENT_VOICE_MAP.cole; // Cole is the default speaker
const MAX_TEXT_CHARS = 800; // Hard cap — controls cost burn per call

module.exports = async (req, res) => {
  // CORS (permissive — endpoint is auth-gated by shared secret, not CORS)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Auth: shared secret
  const expected = process.env.VOICE_INGEST_SECRET;
  if (!expected) {
    console.error('[voice/tts] VOICE_INGEST_SECRET is not configured');
    return res.status(500).json({ ok: false, error: 'Server misconfigured' });
  }
  const auth = req.headers.authorization || req.headers.Authorization || '';
  const presented = (auth.match(/^Bearer\s+(.+)$/i) || [])[1];
  if (!presented || presented.trim() !== expected) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  const text = (body && typeof body.text === 'string') ? body.text.trim() : '';
  if (!text) return res.status(400).json({ ok: false, error: 'text required' });

  // Resolve voice ID — explicit voice_id wins; else agent-name lookup; else default.
  let voiceId = DEFAULT_VOICE_ID;
  if (body && typeof body.voice_id === 'string' && /^[A-Za-z0-9]+$/.test(body.voice_id)) {
    voiceId = body.voice_id;
  } else if (body && typeof body.agent === 'string') {
    const a = body.agent.toLowerCase();
    if (AGENT_VOICE_MAP[a]) voiceId = AGENT_VOICE_MAP[a];
  }

  // Clean + truncate
  const cleaned = text
    .replace(/[*_~`]/g, '')          // markdown
    .replace(/#+\s/g, '')             // headings
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '') // emoji
    .replace(/\s+/g, ' ')
    .trim();
  const finalText = cleaned.length > MAX_TEXT_CHARS
    ? (cleaned.slice(0, MAX_TEXT_CHARS).replace(/\s+\S*$/, '') + '…')
    : cleaned;
  if (!finalText) return res.status(400).json({ ok: false, error: 'empty after clean' });

  // Determine persona name from agent string for OpenAI voice mapping fallback.
  const personaKey = (body && typeof body.agent === 'string') ? body.agent.toLowerCase() : 'cole';

  try {
    const { buffer, provider } = await generateSpeech(finalText, {
      elevenLabsVoiceId: voiceId,
      persona: personaKey,
      elevenLabsModelId: 'eleven_turbo_v2_5',
      voiceSettings: {
        stability: 0.65,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true,
        speed: 1.15,
      },
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Voice-Id', voiceId);
    res.setHeader('X-TTS-Provider', provider);
    res.status(200);
    res.write(buffer);
    return res.end();
  } catch (err) {
    console.error('[voice/tts] fatal', err);
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: 'TTS failed' });
    }
    return res.end();
  }
};
