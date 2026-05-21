// Vercel Serverless Function: /api/speak
// ElevenLabs TTS for Dossie's voice (Luna)

import {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} from './_middleware/rateLimit.js';

const { retryFetch } = require('./_lib/retry.js');

// CORS allowlist — production domains plus any localhost port for dev.
const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_RE = /^https:\/\/meet-dossie-[a-z0-9]+-heathshepard-6590s-projects\.vercel\.app$/;

function applyCors(req, res) {
  // Ultra-permissive CORS - allow ALL origins
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') {
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  return true;
}

export default async function handler(req, res) {
  // Apply CORS first (ultra-permissive)
  applyCors(req, res);

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Log for debugging
  console.log(`[speak.js] ${req.method} from ${req.headers.origin || 'no-origin'}`);

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    // IP-based rate limit: 100 requests/hour.
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'speak', 100, 60 * 60 * 1000);

    const { text, speed } = req.body || {};

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ ok: false, error: 'Text is required' });
    }

    // Speed: 0.25-4.0, default 1.0. Can be overridden via request.
    const voiceSpeed = typeof speed === 'number' && speed >= 0.25 && speed <= 4.0 ? speed : 1.0;

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

    const elevenLabsUrl = 'https://api.elevenlabs.io/v1/text-to-speech/lxYfHSkYm1EzQzGhdbfc/stream';
    const voiceSettings = {
      stability: 0.75,
      similarity_boost: 0.75,
      style: 0.0,
      use_speaker_boost: true,
      speed: voiceSpeed,
    };

    // Generate unique request ID for tracking
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Log for diagnostics
    console.log(`[speak.js] [${requestId}] ElevenLabs URL:`, elevenLabsUrl);
    console.log(`[speak.js] [${requestId}] Voice ID: lxYfHSkYm1EzQzGhdbfc (Luna)`);
    console.log(`[speak.js] [${requestId}] Model: eleven_turbo_v2_5`);
    console.log(`[speak.js] [${requestId}] Voice settings:`, JSON.stringify(voiceSettings));
    console.log(`[speak.js] [${requestId}] Speed:`, voiceSpeed);
    console.log(`[speak.js] [${requestId}] Text length:`, cleanText.length);

    const response = await retryFetch(
      elevenLabsUrl,
      {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text: cleanText,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: voiceSettings,
        }),
      },
      { name: 'ElevenLabs', maxAttempts: 3, baseDelay: 1000 }
    );

    if (!response.ok) {
      // Log full upstream detail server-side; return a generic message.
      const errorBody = await response.text().catch(() => '<no body>');
      console.error('ElevenLabs error:', response.status, errorBody);
      const status = response.status >= 500 ? 502 : response.status;
      return res.status(status).json({ ok: false, error: 'TTS failed' });
    }

    // Stream the audio response directly to the client
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    // Prevent browser caching of audio to avoid stale male voice playback
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Request-ID', requestId);
    console.log(`[speak.js] [${requestId}] Streaming audio to client...`);
    res.status(200);

    // Pipe the response body stream to the client
    if (response.body) {
      const reader = response.body.getReader();
      try {
        let bytesStreamed = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytesStreamed += value.length;
          res.write(Buffer.from(value));
        }
        console.log(`[speak.js] [${requestId}] Stream complete. Bytes sent:`, bytesStreamed);
        res.end();
      } catch (streamError) {
        console.error(`[speak.js] [${requestId}] Stream error:`, streamError);
        if (!res.headersSent) {
          return res.status(500).json({ ok: false, error: 'Stream failed' });
        }
        res.end();
      }
    } else {
      // Fallback if streaming not supported
      const audioBuffer = await response.arrayBuffer();
      console.log(`[speak.js] [${requestId}] Buffer sent. Bytes:`, audioBuffer.byteLength);
      res.write(Buffer.from(audioBuffer));
      res.end();
    }

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
