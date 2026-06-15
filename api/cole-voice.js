// Vercel Serverless Function: /api/cole-voice
// Multiplexed Cole voice loop endpoint for orb-web.html.
// Three operations on one function (Vercel function-count budget):
//
//   POST /api/cole-voice?op=listen
//     Body: raw audio bytes (Content-Type: audio/webm | audio/mp4 | audio/wav ...)
//     -> OpenAI Whisper STT
//     <- 200 { ok:true, transcript }
//
//   POST /api/cole-voice?op=chat
//     Body: { message: string, history?: [{role, content}] }
//     -> Claude Sonnet 4.6 with Cole's chief-of-staff persona
//     <- 200 { ok:true, response }
//
//   POST /api/cole-voice?op=speak
//     Body: { text: string, speed?: number }
//     -> ElevenLabs Bill voice (Cole) via _utils/tts (OpenAI TTS fallback)
//     <- 200 audio/mpeg stream
//
// Auth: none — public for the orb prototype. IP rate-limited per op.
// Env: OPENAI_API_KEY (STT + TTS fallback), ANTHROPIC_API_KEY (chat),
//      ELEVENLABS_API_KEY (TTS primary).
//
// Why multiplexed? The MeetDossie Vercel project has hit the 250-function
// cap. Three separate endpoints (cole-listen / cole-chat / cole-speak) were
// silently dropped from the deploy. Folding into one function keeps the
// surface area to +1 function and unblocks the orb voice loop ship.
// Owner: Atlas (SV-VOICE-002)

import {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} from './_middleware/rateLimit.js';

const { generateSpeech } = require('./_utils/tts');

// ===== Config / constants =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const COLE_VOICE_ID = 'pqHfZKP75CvOlQylNhV4'; // Bill — Cole's permanent voice
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;     // Whisper limit, minus slop
const MAX_TTS_CHARS = 1200;

const COLE_SYSTEM_PROMPT = `You are Cole, Heath Shepard's chief of staff for Shepard Ventures.

Voice & manner:
- Conversational, warm, low-friction. Heath speaks to you naturally and you reply briefly.
- Default to 1-2 sentences unless he explicitly asks for more.
- No corporate hedging, no "as your assistant" preamble, no bullet lists in voice replies.
- Speak in clean prose suitable for text-to-speech: full sentences, no markdown, no symbols, no emoji.
- When Heath asks something open-ended ("how are things?"), respond like a real chief of staff:
  one specific status note plus an offer to go deeper.

Context you know:
- Shepard Ventures is Heath's venture studio. Dossie is the first portfolio company
  (AI transaction coordinator for Texas REALTORS, 12 founding members, around $349 MRR).
- Heath is a 100% SC disabled veteran in San Antonio, Texas.
- Other agents on the team: Hadley (General Counsel), Pierce (Growth & CS),
  Atlas (Platform Engineering), Carter (Product Engineering), Sage (Social Media),
  Quinn (QA), Sterling (Markets).

If you don't know the answer, say so plainly and offer one next step.`;

// Vercel default body parser truncates audio. Disable it for raw audio ops.
export const config = {
  api: { bodyParser: false },
  maxDuration: 30,
};

// ===== Shared helpers =====
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
        reject(Object.assign(new Error('Payload too large'), { code: 'PAYLOAD_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req, maxBytes = 256 * 1024) {
  const buf = await readRawBody(req, maxBytes);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    const err = new Error('Invalid JSON');
    err.code = 'INVALID_JSON';
    throw err;
  }
}

function filenameForMime(mime) {
  const m = (mime || '').toLowerCase();
  if (m.includes('webm')) return 'audio.webm';
  if (m.includes('mp4')) return 'audio.mp4';
  if (m.includes('mpeg') || m.includes('mpga') || m.includes('mp3')) return 'audio.mp3';
  if (m.includes('m4a')) return 'audio.m4a';
  if (m.includes('wav')) return 'audio.wav';
  if (m.includes('ogg')) return 'audio.ogg';
  return 'audio.webm';
}

function cleanForSpeech(text) {
  return String(text || '')
    .replace(/[*_~`]/g, '')
    .replace(/#+\s/g, '')
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ===== Op handlers =====

async function handleListen(req, res, requestId) {
  if (!OPENAI_API_KEY) {
    return res.status(503).json({ ok: false, error: 'STT not configured (OPENAI_API_KEY missing)' });
  }
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('audio/')) {
    return res.status(400).json({
      ok: false,
      error: `Expected audio/* Content-Type, got "${contentType}"`,
    });
  }

  let audioBuffer;
  try {
    audioBuffer = await readRawBody(req, MAX_AUDIO_BYTES);
  } catch (err) {
    if (err.code === 'PAYLOAD_TOO_LARGE') {
      return res.status(413).json({ ok: false, error: 'Audio too large' });
    }
    throw err;
  }

  if (audioBuffer.length === 0) {
    return res.status(400).json({ ok: false, error: 'Empty audio payload' });
  }

  const baseMime = contentType.split(';')[0].trim();
  console.log(`[cole-voice/listen] [${requestId}] ${audioBuffer.length} bytes (${contentType})`);

  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('response_format', 'text');
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
    console.error(`[cole-voice/listen] [${requestId}] Whisper ${whisperRes.status}: ${errText.slice(0, 300)}`);
    return res.status(502).json({ ok: false, error: 'Transcription provider error', status: whisperRes.status });
  }

  const transcript = (await whisperRes.text()).trim();
  console.log(`[cole-voice/listen] [${requestId}] transcript "${transcript.slice(0, 80)}"`);

  if (!transcript) {
    return res.status(200).json({ ok: true, transcript: '', empty: true });
  }
  return res.status(200).json({ ok: true, transcript });
}

async function handleChat(req, res, requestId) {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ ok: false, error: 'Chat not configured (ANTHROPIC_API_KEY missing)' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err.code === 'INVALID_JSON') {
      return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
    }
    throw err;
  }

  const { message, history } = body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ ok: false, error: 'message is required' });
  }

  const sanitizedHistory = Array.isArray(history)
    ? history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
        .slice(-20)
        .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 2000) }))
    : [];

  const finalMessages = [
    ...sanitizedHistory,
    { role: 'user', content: message.slice(0, 4000) },
  ];

  console.log(`[cole-voice/chat] [${requestId}] user msg: "${message.slice(0, 80)}"`);

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: COLE_SYSTEM_PROMPT,
      messages: finalMessages,
    }),
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text().catch(() => '');
    console.error(`[cole-voice/chat] [${requestId}] Claude ${claudeRes.status}: ${errText.slice(0, 300)}`);
    return res.status(502).json({ ok: false, error: 'Claude API error', status: claudeRes.status });
  }

  const data = await claudeRes.json();
  const blocks = Array.isArray(data && data.content) ? data.content : [];
  const text = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();

  if (!text) {
    console.warn(`[cole-voice/chat] [${requestId}] empty Claude response`);
    return res.status(502).json({ ok: false, error: 'Empty response' });
  }

  console.log(`[cole-voice/chat] [${requestId}] reply "${text.slice(0, 80)}"`);
  return res.status(200).json({ ok: true, response: text });
}

async function handleSpeak(req, res, requestId) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err.code === 'INVALID_JSON') {
      return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
    }
    throw err;
  }

  const { text, speed } = body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ ok: false, error: 'text is required' });
  }
  const cleaned = cleanForSpeech(text).slice(0, MAX_TTS_CHARS);
  if (!cleaned) {
    return res.status(400).json({ ok: false, error: 'No text after cleaning' });
  }
  const voiceSpeed = typeof speed === 'number' && speed >= 0.25 && speed <= 4.0 ? speed : 1.0;

  console.log(`[cole-voice/speak] [${requestId}] ${cleaned.length} chars`);

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

  console.log(`[cole-voice/speak] [${requestId}] audio ready (${provider}), ${audioBuffer.length} bytes`);

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('X-TTS-Provider', provider);
  res.status(200);
  res.write(audioBuffer);
  res.end();
}

// ===== Entry point =====
export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const op = String((req.query && req.query.op) || '').toLowerCase();
  if (!['listen', 'chat', 'speak'].includes(op)) {
    return res.status(400).json({
      ok: false,
      error: 'Missing or invalid ?op= (expected one of: listen, chat, speak)',
    });
  }

  const requestId = `cv_${op}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  try {
    // Per-op rate limits — STT is the most expensive so it has the tightest cap.
    const ip = clientIpFromReq(req);
    const limits = {
      listen: { max: 30, windowMs: 60 * 60 * 1000 },
      chat:   { max: 60, windowMs: 60 * 60 * 1000 },
      speak:  { max: 100, windowMs: 60 * 60 * 1000 },
    };
    await checkRateLimit(ip, `cole-voice-${op}`, limits[op].max, limits[op].windowMs);

    if (op === 'listen') return await handleListen(req, res, requestId);
    if (op === 'chat')   return await handleChat(req, res, requestId);
    if (op === 'speak')  return await handleSpeak(req, res, requestId);
  } catch (err) {
    if (err instanceof RateLimitError) {
      if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: 'Rate limit exceeded. Try again later.' });
    }
    console.error(`[cole-voice/${op}] [${requestId}] error:`, err && err.stack ? err.stack : err);
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: 'Internal error' });
    }
    try { res.end(); } catch (_) {}
  }
}
