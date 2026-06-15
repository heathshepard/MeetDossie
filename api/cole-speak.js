// Vercel Serverless Function: /api/cole-speak
// Cole's voice (Bill) — ElevenLabs TTS for the orb-web.html loop.
// Mirrors /api/speak (Dossie/Luna) but uses Bill's voice ID and a Cole
// persona — keeps Cole's voice consistent across surfaces.
//
// Body: { text: string, speed?: number }
// Response: audio/mpeg stream
// Env: ELEVENLABS_API_KEY (primary), OPENAI_API_KEY (fallback via _utils/tts)
// Owner: Atlas (SV-VOICE-002 / Cole voice loop)

import {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} from './_middleware/rateLimit.js';

const { generateSpeech } = require('./_utils/tts');

// Bill — Cole's permanent voice per memory ("Cole = Bill" 2026-06-10).
const COLE_VOICE_ID = 'pqHfZKP75CvOlQylNhV4';
const MAX_TEXT_CHARS = 1200; // hard cap — keeps spend predictable per call

export const config = { maxDuration: 30 };

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// Plain-prose cleanup for TTS — same spirit as /api/speak. Strips markdown,
// emoji, asterisks, and other symbols that ElevenLabs reads literally.
function cleanForSpeech(text) {
  return String(text || '')
    .replace(/[*_~`]/g, '')
    .replace(/#+\s/g, '')
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'cole-speak', 100, 60 * 60 * 1000);

    const { text, speed } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ ok: false, error: 'text is required' });
    }

    const cleaned = cleanForSpeech(text).slice(0, MAX_TEXT_CHARS);
    if (!cleaned) {
      return res.status(400).json({ ok: false, error: 'No text after cleaning' });
    }

    const voiceSpeed =
      typeof speed === 'number' && speed >= 0.25 && speed <= 4.0 ? speed : 1.0;

    const requestId = `csp_${Date.now()}_${Math.random().toString(36).substr(2, 7)}`;
    console.log(`[cole-speak] [${requestId}] ${cleaned.length} chars`);

    const { buffer: audioBuffer, provider } = await generateSpeech(cleaned, {
      elevenLabsVoiceId: COLE_VOICE_ID,
      persona: 'cole',
      elevenLabsModelId: 'eleven_turbo_v2_5',
      voiceSettings: {
        stability: 0.55,
        similarity_boost: 0.78,
        style: 0.0,
        use_speaker_boost: true,
        speed: voiceSpeed,
      },
    });

    console.log(
      `[cole-speak] [${requestId}] audio ready (provider: ${provider}), ${audioBuffer.length} bytes`
    );

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('X-TTS-Provider', provider);
    res.status(200);
    res.write(audioBuffer);
    res.end();
  } catch (err) {
    if (err instanceof RateLimitError) {
      if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: 'Rate limit exceeded. Try again later.' });
    }
    console.error('[cole-speak] error:', err && err.stack ? err.stack : err, {
      elevenlabsKeySet: !!process.env.ELEVENLABS_API_KEY,
      openaiKeySet: !!process.env.OPENAI_API_KEY,
    });
    return res.status(500).json({ ok: false, error: 'Failed to generate speech' });
  }
}
