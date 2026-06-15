// Vercel Serverless Function: /api/cole-listen
// Browser-to-Cole STT: accepts a recorded audio blob from orb-web.html,
// sends it to OpenAI Whisper, returns { transcript }.
//
// Body: multipart/form-data with field "audio" (Blob), OR raw audio bytes
//       with Content-Type: audio/webm | audio/mp4 | audio/mpeg | audio/wav.
//       We accept raw bytes too because the browser MediaRecorder produces a
//       single Blob and a raw POST is simpler from the client than multipart.
// Response: { transcript: string } on 200, { ok:false, error } otherwise.
//
// Env: OPENAI_API_KEY
// Auth: none — endpoint is public for the orb prototype. IP rate-limited
//       (30 req/hr) to prevent abuse. Long-term we'll move this behind an
//       auth gate once Cole is wired to a real user account.
// Owner: Atlas (SV-VOICE-002 / Cole voice loop)

import {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} from './_middleware/rateLimit.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Whisper hard caps file size at 25 MB; we cap at 24 MB to be safe.
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
// Browser MediaRecorder typically emits audio/webm with opus codec.
// Whisper accepts: mp3, mp4, mpeg, mpga, m4a, wav, webm.
const ALLOWED_MIMES = new Set([
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/mpeg',
  'audio/mpga',
  'audio/m4a',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/ogg;codecs=opus',
]);

// Vercel default body parser truncates at 4 MB and refuses audio types.
// Disable it so we can read the raw request stream ourselves.
export const config = {
  api: { bodyParser: false },
  maxDuration: 30,
};

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

async function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Map an arbitrary audio content-type to a Whisper-friendly filename so the
// API recognises the format from the Content-Disposition header.
function filenameForMime(mime) {
  const m = (mime || '').toLowerCase();
  if (m.includes('webm')) return 'audio.webm';
  if (m.includes('mp4')) return 'audio.mp4';
  if (m.includes('mpeg') || m.includes('mpga') || m.includes('mp3')) return 'audio.mp3';
  if (m.includes('m4a')) return 'audio.m4a';
  if (m.includes('wav')) return 'audio.wav';
  if (m.includes('ogg')) return 'audio.ogg';
  return 'audio.webm'; // safe default — MediaRecorder default
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!OPENAI_API_KEY) {
    console.error('[cole-listen] OPENAI_API_KEY not set');
    return res.status(503).json({
      ok: false,
      error: 'STT not configured — OPENAI_API_KEY missing',
    });
  }

  try {
    // IP-based rate limit: 30 transcriptions per hour. Cole's loop is
    // gesture-driven, so a legitimate user won't approach this in a session.
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'cole-listen', 30, 60 * 60 * 1000);

    const contentType = (req.headers['content-type'] || '').toLowerCase();

    // We accept raw audio bytes only. Multipart could be added later, but
    // the orb client posts the MediaRecorder Blob directly which is simpler.
    if (!contentType.startsWith('audio/')) {
      return res.status(400).json({
        ok: false,
        error: `Expected audio/* Content-Type, got "${contentType}"`,
      });
    }

    // Normalise: strip codec/params for mime check.
    const baseMime = contentType.split(';')[0].trim();
    if (!ALLOWED_MIMES.has(baseMime) && !ALLOWED_MIMES.has(contentType)) {
      // We still proceed — Whisper is tolerant — but log so we can spot edge mimes.
      console.warn('[cole-listen] unusual mime:', contentType);
    }

    const audioBuffer = await readRawBody(req, MAX_AUDIO_BYTES);
    if (audioBuffer.length === 0) {
      return res.status(400).json({ ok: false, error: 'Empty audio payload' });
    }
    if (audioBuffer.length > MAX_AUDIO_BYTES) {
      return res.status(413).json({
        ok: false,
        error: `Audio too large (${audioBuffer.length} bytes; max ${MAX_AUDIO_BYTES})`,
      });
    }

    const requestId = `clst_${Date.now()}_${Math.random().toString(36).substr(2, 7)}`;
    console.log(`[cole-listen] [${requestId}] ${audioBuffer.length} bytes (${contentType})`);

    // Build multipart form for Whisper — Node 18+ has global Blob/FormData.
    const form = new FormData();
    form.append('model', 'whisper-1');
    form.append('response_format', 'text');
    // Optional but improves cold-start accuracy: a brief language hint.
    form.append('language', 'en');
    const blob = new Blob([audioBuffer], { type: baseMime });
    form.append('file', blob, filenameForMime(baseMime));

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });

    if (!whisperRes.ok) {
      const errText = await whisperRes.text().catch(() => '');
      console.error(`[cole-listen] [${requestId}] Whisper ${whisperRes.status}: ${errText.slice(0, 300)}`);
      return res.status(502).json({
        ok: false,
        error: 'Transcription provider error',
        status: whisperRes.status,
      });
    }

    // response_format: 'text' → returns plain text body, not JSON.
    const transcript = (await whisperRes.text()).trim();
    console.log(`[cole-listen] [${requestId}] transcript "${transcript.slice(0, 80)}"`);

    if (!transcript) {
      // Whisper returned empty — usually a clip that was all silence/noise.
      return res.status(200).json({ ok: true, transcript: '', empty: true });
    }

    return res.status(200).json({ ok: true, transcript });
  } catch (err) {
    if (err instanceof RateLimitError) {
      if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: 'Rate limit exceeded. Try again later.' });
    }
    if (err && err.message === 'Payload too large') {
      return res.status(413).json({ ok: false, error: 'Audio too large' });
    }
    console.error('[cole-listen] error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'Transcription failed' });
  }
}
