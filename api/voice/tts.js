// /api/voice/tts — ElevenLabs TTS proxy for Shepard Ventures agents.
//
// Auth: Bearer <VOICE_INGEST_SECRET> shared with the local Claude Code hook.
// Body: { text: string, voice_id?: string, agent?: string }
// Response: audio/mpeg stream
//
// Owner: Atlas (SV-VOICE-001)

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

  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(500).json({ ok: false, error: 'ELEVENLABS_API_KEY not configured' });
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

  try {
    const elevenUrl = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;
    const upstream = await fetch(elevenUrl, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
      },
      body: JSON.stringify({
        text: finalText,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.65,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
          speed: 1.15,
        },
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '<no body>');
      console.error('[voice/tts] ElevenLabs upstream error', upstream.status, detail.slice(0, 200));
      return res.status(upstream.status >= 500 ? 502 : upstream.status).json({
        ok: false, error: 'TTS upstream failed', status: upstream.status,
      });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Voice-Id', voiceId);
    res.status(200);

    // Stream upstream → client
    if (upstream.body && typeof upstream.body.getReader === 'function') {
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      return res.end();
    }
    // Fallback: buffered
    const buf = await upstream.arrayBuffer();
    res.write(Buffer.from(buf));
    return res.end();
  } catch (err) {
    console.error('[voice/tts] fatal', err);
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: 'TTS failed' });
    }
    return res.end();
  }
};
