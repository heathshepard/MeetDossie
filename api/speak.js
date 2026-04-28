// Vercel Serverless Function: /api/speak
// ElevenLabs TTS for Dossie's voice (Jessica)

import {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} from './_middleware/rateLimit.js';

// CORS allowlist — production domains plus any localhost port for dev.
const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin)) {
      allowOrigin = origin;
    }
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin);
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    // IP-based rate limit: 100 requests/hour.
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'speak', 100, 60 * 60 * 1000);

    const { text } = req.body || {};

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ ok: false, error: 'Text is required' });
    }

    if (!process.env.ELEVENLABS_API_KEY) {
      console.error('ELEVENLABS_API_KEY not configured');
      return res.status(500).json({ ok: false, error: 'Server configuration error' });
    }

    const formatSpokenDate = (s) => {
      const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const ordinals = ['','1st','2nd','3rd','4th','5th','6th','7th','8th','9th','10th','11th','12th','13th','14th','15th','16th','17th','18th','19th','20th','21st','22nd','23rd','24th','25th','26th','27th','28th','29th','30th','31st'];
      return s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (match, year, month, day) => {
        const m = months[parseInt(month, 10) - 1];
        const d = ordinals[parseInt(day, 10)];
        if (!m || !d) return match;
        return `${m} ${d}, ${year}`;
      });
    };
    const preprocessText = (t) => formatSpokenDate(t)
      .replace(/\bTX\b/g, 'Texas')
      .replace(/\bBoerne\b/gi, 'Bernie')
      .replace(/\bBexar\b/gi, 'Bear')
      .replace(/\bManor\b/gi, 'MAY-ner')
      .replace(/\bPflugerville\b/gi, 'Flooger-ville')
      .replace(/\bCibolo\b/gi, 'Sih-bolo')
      .replace(/\bSchertz\b/gi, 'Sherts')
      .replace(/\bSeguin\b/gi, 'Seh-geen')
      .replace(/\bConverse\b/gi, 'CON-vers')
      .replace(/\bHelotes\b/gi, 'Heh-LOW-tees');

    // Strip markdown, emoji, asterisks
    const cleanText = preprocessText(text)
      .replace(/[*_~`]/g, '')
      .replace(/#+\s/g, '')
      .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
      .trim();

    if (!cleanText) {
      return res.status(400).json({ ok: false, error: 'No text after cleaning' });
    }

    const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/lxYfHSkYm1EzQzGhdbfc', {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
      },
      body: JSON.stringify({
        text: cleanText,
        model_id: 'eleven_flash_v2_5',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.25,
          use_speaker_boost: true,
          speed: 1.0,
        },
      }),
    });

    if (!response.ok) {
      // Log full upstream detail server-side; return a generic message.
      const errorBody = await response.text().catch(() => '<no body>');
      console.error('ElevenLabs error:', response.status, errorBody);
      const status = response.status >= 500 ? 502 : response.status;
      return res.status(status).json({ ok: false, error: 'TTS failed' });
    }

    const audioBuffer = await response.arrayBuffer();

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.byteLength);
    res.status(200).send(Buffer.from(audioBuffer));

  } catch (error) {
    console.error('Speak API error:', error);

    if (error instanceof RateLimitError) {
      if (error.retryAfterSeconds) {
        res.setHeader('Retry-After', String(error.retryAfterSeconds));
      }
      return res.status(429).json({
        ok: false,
        error: 'Rate limit exceeded. Please try again later.'
      });
    }

    // Generic sanitized response — never leak fetch errors / API keys.
    return res.status(500).json({ ok: false, error: 'Failed to generate speech' });
  }
}
