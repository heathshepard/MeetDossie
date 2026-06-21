// Vercel Serverless Function: /api/jarvis-voice
// Heath's personal Jarvis voice loop. Multiplexed (5 ops, 1 function) to stay
// under the 250-function cap on the MeetDossie Vercel project.
//
//   POST /api/jarvis-voice?op=stt
//     Body: raw audio (Content-Type: audio/webm | audio/mp4 | audio/wav ...)
//     -> ElevenLabs Speech-to-Text (scribe_v1)
//     <- 200 { ok:true, transcript }
//
//   POST /api/jarvis-voice?op=chat
//     Body: { conversation_id?, message: string }
//     -> Claude Sonnet 4.6 with Heath's tenant persona (loaded from DB)
//     <- 200 { ok:true, conversation_id, message_id, response }
//
//   POST /api/jarvis-voice?op=tts
//     Body: { text: string }
//     -> ElevenLabs George voice with locked settings
//     <- 200 audio/mpeg stream
//
//   POST /api/jarvis-voice?op=conversation_start
//     Body: { device_id?, device_label?, user_agent? }
//     <- 200 { ok:true, conversation_id }
//
//   POST /api/jarvis-voice?op=conversation_end
//     Body: { conversation_id }
//     <- 200 { ok:true, title }
//
// Auth: REQUIRED. Bearer Supabase JWT. Looked up against jarvis_users to
//       resolve tenant_id; if no row, 403.
// Env: ELEVENLABS_API_KEY (STT + TTS), ANTHROPIC_API_KEY (chat),
//      SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (DB).
// Owner: Atlas (SV-JARVIS-PWA-001)

import { verifySupabaseToken } from './_middleware/auth.js';

// ===== Config =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
// Min raw bytes we will pass through to Whisper. Anything smaller is almost
// certainly silence / a stray short tap and Whisper itself rejects it with a
// 400 ("Audio file is too short"). We catch it client-friendly as a 400 and
// signal `audio_empty_or_too_short` so the client surfaces "I didn't catch
// that" instead of treating it as a 5xx provider failure.
const MIN_AUDIO_BYTES = 2 * 1024;
const MAX_TTS_CHARS = 1200;
const STT_TIMEOUT_MS = 5000;     // DoD criterion 26
const TTS_TIMEOUT_MS = 3000;     // DoD criterion 25
const CHAT_TIMEOUT_MS = 15000;

// George voice — DoD criterion 22 (locked)
const GEORGE_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
const GEORGE_MODEL = 'eleven_multilingual_v2';
const GEORGE_SETTINGS = {
  stability: 0.55,
  similarity_boost: 0.50,
  style: 0.45,
  use_speaker_boost: true,
};

export const config = {
  api: { bodyParser: false },
  maxDuration: 30,
};

// ===== Persona — loaded fresh per request from tenants row =====
function buildSystemPrompt(tenant) {
  const addressing = tenant?.addressing_pref || 'sir';
  const displayName = tenant?.display_name || 'sir';

  return `You are Jarvis — ${displayName}'s personal AI chief of staff.

Voice & manner:
- Address ${displayName} as "${addressing}" most of the time, but vary it naturally. Sometimes use his name, sometimes just answer. Don't be robotic.
- Terse-but-warm. Default to 1-3 sentences. Only go long when explicitly asked ("walk me through", "tell me more", "explain").
- Light humor and sarcasm welcome — calibrated, not slapstick.
- No "as your AI assistant" preamble. No corporate hedging. No "I'm just an AI."
- Speak in clean prose for text-to-speech: full sentences, no markdown, no bullets, no symbols, no emoji.
- When ${displayName} is frustrated, acknowledge calmly and offer a retry or alternative. No theater.

Honesty:
- Acknowledge your own limits when relevant ("I can't see your texts on Android, ${addressing}"), but don't open every reply with a disclaimer.
- Never fabricate specifics — numbers, names, dates. If you don't know, say so plainly and offer to find out.

Context:
- ${displayName} runs Shepard Ventures (venture studio). Dossie is the first portfolio company — AI transaction coordinator for Texas REALTORS.
- Other agents you can spawn on his behalf: Atlas (platform engineering), Carter (product engineering), Hadley (general counsel), Pierce (growth and CS), Sage (social media), Quinn (QA), Ridge (reliability), Sterling (markets).
- ${displayName} is in San Antonio, Texas. He's a 100% SC disabled veteran. Direct communicator. Speed beats perfection on iteration loops but never sloppy on foundations.

When a tool call is appropriate (web search, send a message, read calendar, spawn an agent, etc.), name it explicitly in your reply so the wrapper can execute. For state-changing actions (send, purchase, submit), ALWAYS confirm verbally before firing: "${addressing.charAt(0).toUpperCase() + addressing.slice(1)}, I'm about to send X. Confirm?"`;
}

// ===== Helpers =====
function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
  if (m.includes('mpeg') || m.includes('mp3')) return 'audio.mp3';
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

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(Object.assign(new Error(`${label} timed out`), { code: 'TIMEOUT' })), ms)
    ),
  ]);
}

// ===== Supabase REST helpers (service-role, scoped by tenant_id in code) =====
async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sbGet ${path} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function sbPost(path, body, { prefer = 'return=representation' } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`sbPost ${path} -> ${res.status} ${errBody.slice(0, 200)}`);
  }
  return prefer.includes('representation') ? res.json() : null;
}

async function sbPatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`sbPatch ${path} -> ${res.status} ${errBody.slice(0, 200)}`);
  }
  return res.json();
}

// Resolve { tenant, jarvisUser } for the calling auth user.
async function resolveTenant(authUserId) {
  const rows = await sbGet(
    `jarvis_users?select=id,tenant_id,role,tenants(id,slug,display_name,theme,voice_id,voice_settings,addressing_pref)&auth_user_id=eq.${authUserId}&limit=1`
  );
  if (!rows || rows.length === 0) return null;
  return { jarvisUser: rows[0], tenant: rows[0].tenants };
}

// ===== Op handlers =====

async function handleSTT(req, res, requestId) {
  // ElevenLabs Speech-to-Text (scribe_v1) — replaced OpenAI Whisper 2026-06-20
  // after the OpenAI account hit insufficient_quota (429) bouncing every
  // Heath recording as "Provider error". ElevenLabs key reused from TTS path.
  if (!ELEVENLABS_API_KEY) {
    return res.status(503).json({ ok: false, error: 'STT not configured' });
  }
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('audio/')) {
    return res.status(400).json({ ok: false, error: `Expected audio/* Content-Type, got "${contentType}"` });
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
    return res.status(400).json({ ok: false, error: 'audio_empty_or_too_short', detail: 'Empty audio payload' });
  }
  if (audioBuffer.length < MIN_AUDIO_BYTES) {
    // Short audio (~<2KB raw webm) is almost always a stray tap or silence.
    // Surface as 400 with the same error code the client uses for empty
    // transcripts so the UX falls back to "I didn't catch that, sir."
    console.log(`[jarvis-voice/stt] [${requestId}] short audio ${audioBuffer.length}b — skipping STT`);
    return res.status(400).json({ ok: false, error: 'audio_empty_or_too_short', bytes: audioBuffer.length });
  }

  const baseMime = contentType.split(';')[0].trim();
  console.log(`[jarvis-voice/stt] [${requestId}] ${audioBuffer.length} bytes (${baseMime}) -> ElevenLabs scribe_v1`);

  const form = new FormData();
  form.append('model_id', 'scribe_v1');
  const blob = new Blob([audioBuffer], { type: baseMime });
  form.append('file', blob, filenameForMime(baseMime));

  let sttRes;
  try {
    sttRes = await withTimeout(
      fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_API_KEY },
        body: form,
      }),
      STT_TIMEOUT_MS,
      'ElevenLabsSTT'
    );
  } catch (err) {
    if (err.code === 'TIMEOUT') {
      console.warn(`[jarvis-voice/stt] [${requestId}] ElevenLabs STT timeout`);
      return res.status(504).json({ ok: false, error: 'STT timeout', fallback: 'retry' });
    }
    throw err;
  }

  if (!sttRes.ok) {
    const errText = await sttRes.text().catch(() => '');
    console.error(`[jarvis-voice/stt] [${requestId}] ElevenLabs ${sttRes.status}: ${errText.slice(0, 300)}`);
    // ElevenLabs returns 400 for "audio too short" / "invalid file" / decoding
    // failed. Treat those as client-friendly 400s instead of 502s — the user
    // didn't say anything meaningful, not a true provider outage.
    if (sttRes.status === 400) {
      return res.status(400).json({ ok: false, error: 'audio_empty_or_too_short', detail: errText.slice(0, 200) });
    }
    return res.status(502).json({ ok: false, error: 'STT provider error', status: sttRes.status });
  }

  let transcript = '';
  try {
    const data = await sttRes.json();
    transcript = String((data && data.text) || '').trim();
  } catch (err) {
    console.error(`[jarvis-voice/stt] [${requestId}] failed parsing ElevenLabs response: ${err.message}`);
    return res.status(502).json({ ok: false, error: 'STT provider error', detail: 'invalid_response_shape' });
  }
  console.log(`[jarvis-voice/stt] [${requestId}] "${transcript.slice(0, 80)}"`);
  return res.status(200).json({ ok: true, transcript, empty: !transcript });
}

async function handleChat(req, res, requestId, { tenant, jarvisUser }) {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ ok: false, error: 'Chat not configured' });
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

  const { conversation_id, message } = body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ ok: false, error: 'message is required' });
  }

  // Ensure / create the conversation
  let convId = conversation_id;
  if (!convId) {
    const created = await sbPost('jarvis_conversations', {
      tenant_id: tenant.id,
      user_id: jarvisUser.id,
      started_at: new Date().toISOString(),
    });
    convId = created[0].id;
    console.log(`[jarvis-voice/chat] [${requestId}] new conv ${convId}`);
  }

  // Load last 20 messages from this conversation for history
  const history = await sbGet(
    `jarvis_messages?select=role,content&conversation_id=eq.${convId}&order=created_at.asc&limit=20`
  );

  // Persist the user message
  await sbPost('jarvis_messages', {
    conversation_id: convId,
    tenant_id: tenant.id,
    role: 'user',
    content: message.slice(0, 4000),
  }, { prefer: 'return=minimal' });

  const finalMessages = [
    ...history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 4000) })),
    { role: 'user', content: message.slice(0, 4000) },
  ];

  const systemPrompt = buildSystemPrompt(tenant);
  console.log(`[jarvis-voice/chat] [${requestId}] tenant=${tenant.slug} msg="${message.slice(0, 80)}"`);

  let claudeRes;
  try {
    claudeRes = await withTimeout(
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 500,
          system: systemPrompt,
          messages: finalMessages,
        }),
      }),
      CHAT_TIMEOUT_MS,
      'Claude'
    );
  } catch (err) {
    if (err.code === 'TIMEOUT') {
      return res.status(504).json({ ok: false, error: 'Chat timeout', fallback: 'retry' });
    }
    throw err;
  }

  if (!claudeRes.ok) {
    const errText = await claudeRes.text().catch(() => '');
    console.error(`[jarvis-voice/chat] [${requestId}] Claude ${claudeRes.status}: ${errText.slice(0, 300)}`);
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
    return res.status(502).json({ ok: false, error: 'Empty Claude response' });
  }

  // Persist the assistant message
  const usage = data.usage || {};
  const assistantRow = await sbPost('jarvis_messages', {
    conversation_id: convId,
    tenant_id: tenant.id,
    role: 'assistant',
    content: text,
    tokens_in: usage.input_tokens || null,
    tokens_out: usage.output_tokens || null,
  });

  return res.status(200).json({
    ok: true,
    conversation_id: convId,
    message_id: assistantRow[0].id,
    response: text,
  });
}

async function handleTTS(req, res, requestId, { tenant }) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err.code === 'INVALID_JSON') {
      return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
    }
    throw err;
  }
  const { text } = body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ ok: false, error: 'text is required' });
  }
  const cleaned = cleanForSpeech(text).slice(0, MAX_TTS_CHARS);
  if (!cleaned) {
    return res.status(400).json({ ok: false, error: 'No text after cleaning' });
  }

  // Tenant voice config (defaults to George)
  const voiceId = tenant?.voice_id || GEORGE_VOICE_ID;
  const settings = tenant?.voice_settings || GEORGE_SETTINGS;
  const modelId = settings.model || GEORGE_MODEL;

  if (!ELEVENLABS_API_KEY) {
    // Fallback path — return 503 so client falls back to SpeechSynthesis (DoD 25)
    console.warn(`[jarvis-voice/tts] [${requestId}] ELEVENLABS_API_KEY missing`);
    return res.status(503).json({ ok: false, error: 'TTS not configured', fallback: 'speech-synthesis' });
  }

  console.log(`[jarvis-voice/tts] [${requestId}] ${cleaned.length} chars voice=${voiceId}`);

  let ttsRes;
  try {
    ttsRes = await withTimeout(
      fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: cleaned,
          model_id: modelId,
          voice_settings: {
            stability: settings.stability ?? GEORGE_SETTINGS.stability,
            similarity_boost: settings.similarity_boost ?? GEORGE_SETTINGS.similarity_boost,
            style: settings.style ?? GEORGE_SETTINGS.style,
            use_speaker_boost: settings.use_speaker_boost ?? true,
          },
        }),
      }),
      TTS_TIMEOUT_MS,
      'ElevenLabs'
    );
  } catch (err) {
    if (err.code === 'TIMEOUT') {
      console.warn(`[jarvis-voice/tts] [${requestId}] ElevenLabs timeout`);
      return res.status(504).json({ ok: false, error: 'TTS timeout', fallback: 'speech-synthesis' });
    }
    throw err;
  }

  if (!ttsRes.ok) {
    const errText = await ttsRes.text().catch(() => '');
    console.error(`[jarvis-voice/tts] [${requestId}] ElevenLabs ${ttsRes.status}: ${errText.slice(0, 300)}`);
    return res.status(502).json({ ok: false, error: 'TTS provider error', status: ttsRes.status, fallback: 'speech-synthesis' });
  }

  const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
  console.log(`[jarvis-voice/tts] [${requestId}] audio ${audioBuffer.length} bytes`);

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('X-Jarvis-Voice', voiceId);
  res.status(200);
  res.write(audioBuffer);
  res.end();
}

// ===== Streaming chat + TTS pipeline =====
// Single SSE response that interleaves:
//   - text deltas (for UI append)
//   - sentence boundaries (server-extracted)
//   - audio chunks (ElevenLabs MP3, base64 per sentence)
//   - done event with conversation_id + full text + message_id
//
// Client plays each sentence's audio as soon as it arrives, chaining via
// HTMLAudioElement.onended. First-token-to-first-byte-audio is roughly:
//   Claude TTFT (~250ms) + first sentence (~400ms more for ~10 words) +
//   ElevenLabs TTFT (~400ms) = ~1.0-1.2s user-perceived response start.
//
// Falls back gracefully: if Claude stream fails before any audio, returns
// error event; client falls back to legacy /op=chat + /op=tts path.
async function handleChatTTSStream(req, res, requestId, { tenant, jarvisUser }) {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ ok: false, error: 'Chat not configured' });
  }
  if (!ELEVENLABS_API_KEY) {
    return res.status(503).json({ ok: false, error: 'TTS not configured', fallback: 'speech-synthesis' });
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
  const { conversation_id, message } = body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ ok: false, error: 'message is required' });
  }

  // Ensure / create the conversation
  let convId = conversation_id;
  if (!convId) {
    const created = await sbPost('jarvis_conversations', {
      tenant_id: tenant.id,
      user_id: jarvisUser.id,
      started_at: new Date().toISOString(),
    });
    convId = created[0].id;
  }

  // Load history + persist user message in parallel
  const [history] = await Promise.all([
    sbGet(`jarvis_messages?select=role,content&conversation_id=eq.${convId}&order=created_at.asc&limit=20`),
    sbPost('jarvis_messages', {
      conversation_id: convId,
      tenant_id: tenant.id,
      role: 'user',
      content: message.slice(0, 4000),
    }, { prefer: 'return=minimal' }),
  ]);

  const finalMessages = [
    ...history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 4000) })),
    { role: 'user', content: message.slice(0, 4000) },
  ];

  const systemPrompt = buildSystemPrompt(tenant);
  const voiceId = tenant?.voice_id || GEORGE_VOICE_ID;
  const settings = tenant?.voice_settings || GEORGE_SETTINGS;
  const modelId = settings.model || GEORGE_MODEL;

  console.log(`[jarvis-voice/chat_tts_stream] [${requestId}] conv=${convId} tenant=${tenant.slug} msg="${message.slice(0, 80)}"`);

  // ===== Set up SSE response =====
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx-style buffering on proxies
  res.setHeader('X-Request-ID', requestId);
  res.status(200);

  const writeEvent = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      console.warn(`[jarvis-voice/chat_tts_stream] [${requestId}] write fail: ${e.message}`);
    }
  };

  // Send conversation_id immediately so client can persist
  writeEvent('meta', { conversation_id: convId });

  // ===== Start Claude stream =====
  let claudeRes;
  try {
    claudeRes = await withTimeout(
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 500,
          stream: true,
          system: systemPrompt,
          messages: finalMessages,
        }),
      }),
      CHAT_TIMEOUT_MS,
      'ClaudeStream'
    );
  } catch (err) {
    writeEvent('error', { error: err.code === 'TIMEOUT' ? 'Chat timeout' : 'Chat connect failed', fallback: 'retry' });
    return res.end();
  }

  if (!claudeRes.ok || !claudeRes.body) {
    const errText = await claudeRes.text().catch(() => '');
    console.error(`[jarvis-voice/chat_tts_stream] [${requestId}] Claude ${claudeRes.status}: ${errText.slice(0, 300)}`);
    writeEvent('error', { error: 'Claude API error', status: claudeRes.status });
    return res.end();
  }

  // ===== Sentence extraction state =====
  let fullText = '';
  let buffer = '';
  let sentenceSeq = 0;
  const ttsPromises = [];     // serialized chain of TTS+send work
  let ttsChain = Promise.resolve();
  let usageIn = null, usageOut = null;

  // Splits buffer on sentence boundaries. Returns array of complete sentences
  // and updates the buffer with the trailing partial.
  // Sentence boundary = period/!/?/colon followed by whitespace OR end of buffer.
  // Also break at newline. Minimum sentence length ~25 chars to avoid TTS-ing
  // "Yes." or "Mr." mid-sentence; if buffer >120 chars without a boundary,
  // force a flush at the last comma/space.
  function extractSentences(forceFlush = false) {
    const out = [];
    // Match: text ending in . ! ? : followed by space/newline OR end-of-string.
    // Avoid splitting at decimals (0.5) or abbreviations by requiring whitespace
    // or end after the punctuation.
    const sentenceRegex = /([^.!?:\n]+?[.!?:\n])(\s+|$)/g;
    let lastIdx = 0;
    let m;
    while ((m = sentenceRegex.exec(buffer)) !== null) {
      const candidate = (buffer.slice(lastIdx, sentenceRegex.lastIndex)).trim();
      if (candidate.length >= 12) {
        out.push(candidate);
        lastIdx = sentenceRegex.lastIndex;
      }
      // else: too short, keep accumulating (avoid TTSing "Mr." alone)
    }
    buffer = buffer.slice(lastIdx);

    // Hard flush if buffer is huge with no boundary
    if (buffer.length > 160) {
      // break at last space/comma
      const breakAt = Math.max(buffer.lastIndexOf(', '), buffer.lastIndexOf(' '));
      if (breakAt > 40) {
        out.push(buffer.slice(0, breakAt + 1).trim());
        buffer = buffer.slice(breakAt + 1);
      }
    }

    if (forceFlush && buffer.trim().length > 0) {
      out.push(buffer.trim());
      buffer = '';
    }
    return out;
  }

  // TTS a single sentence + send as event. Returns a promise chained to ttsChain.
  function queueSentenceTTS(sentence) {
    const seq = sentenceSeq++;
    const clean = cleanForSpeech(sentence);
    if (!clean) return;
    writeEvent('sentence', { seq, text: sentence });

    // Chain: each TTS request fires in order so audio events arrive in order.
    // Within a chain link, we fire the ElevenLabs request immediately but
    // serialize the *write* of audio bytes after the previous link to keep
    // base64 chunks in sequence.
    const fetchPromise = (async () => {
      try {
        const ttsRes = await withTimeout(
          fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`, {
            method: 'POST',
            headers: {
              'xi-api-key': ELEVENLABS_API_KEY,
              'Content-Type': 'application/json',
              Accept: 'audio/mpeg',
            },
            body: JSON.stringify({
              text: clean,
              model_id: modelId,
              voice_settings: {
                stability: settings.stability ?? GEORGE_SETTINGS.stability,
                similarity_boost: settings.similarity_boost ?? GEORGE_SETTINGS.similarity_boost,
                style: settings.style ?? GEORGE_SETTINGS.style,
                use_speaker_boost: settings.use_speaker_boost ?? true,
              },
            }),
          }),
          TTS_TIMEOUT_MS,
          'ElevenLabsSentence'
        );
        if (!ttsRes.ok) {
          const t = await ttsRes.text().catch(() => '');
          console.warn(`[jarvis-voice/chat_tts_stream] [${requestId}] tts ${ttsRes.status} seq=${seq}: ${t.slice(0, 200)}`);
          return null;
        }
        return Buffer.from(await ttsRes.arrayBuffer());
      } catch (err) {
        console.warn(`[jarvis-voice/chat_tts_stream] [${requestId}] tts err seq=${seq}: ${err.message}`);
        return null;
      }
    })();
    ttsPromises.push(fetchPromise);

    ttsChain = ttsChain.then(async () => {
      const buf = await fetchPromise;
      if (buf && buf.length) {
        writeEvent('audio', { seq, base64: buf.toString('base64') });
      } else {
        writeEvent('audio_error', { seq });
      }
    });
  }

  // ===== Consume Claude SSE =====
  try {
    const reader = claudeRes.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let leftover = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      leftover += decoder.decode(value, { stream: true });
      // SSE events separated by \n\n; each event has "data: {...}" line(s)
      let nlIdx;
      while ((nlIdx = leftover.indexOf('\n\n')) !== -1) {
        const rawEvent = leftover.slice(0, nlIdx);
        leftover = leftover.slice(nlIdx + 2);
        const lines = rawEvent.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let evt;
          try { evt = JSON.parse(payload); } catch { continue; }
          if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
            const delta = evt.delta.text || '';
            if (!delta) continue;
            fullText += delta;
            buffer += delta;
            writeEvent('text', { delta });
            const sentences = extractSentences(false);
            for (const s of sentences) queueSentenceTTS(s);
          } else if (evt.type === 'message_delta' && evt.usage) {
            usageOut = evt.usage.output_tokens || null;
          } else if (evt.type === 'message_start' && evt.message && evt.message.usage) {
            usageIn = evt.message.usage.input_tokens || null;
          }
        }
      }
    }
    // Final flush — any remaining buffer becomes the last sentence
    const tail = extractSentences(true);
    for (const s of tail) queueSentenceTTS(s);
  } catch (err) {
    console.error(`[jarvis-voice/chat_tts_stream] [${requestId}] stream parse err: ${err.message}`);
    writeEvent('error', { error: 'Stream parse failed' });
  }

  // Wait for all TTS writes to complete before sending done
  try {
    await ttsChain;
  } catch (err) {
    console.warn(`[jarvis-voice/chat_tts_stream] [${requestId}] ttsChain err: ${err.message}`);
  }

  // Persist assistant message
  let messageId = null;
  if (fullText.trim()) {
    try {
      const row = await sbPost('jarvis_messages', {
        conversation_id: convId,
        tenant_id: tenant.id,
        role: 'assistant',
        content: fullText.trim(),
        tokens_in: usageIn,
        tokens_out: usageOut,
      });
      messageId = row && row[0] && row[0].id;
    } catch (err) {
      console.warn(`[jarvis-voice/chat_tts_stream] [${requestId}] persist assistant fail: ${err.message}`);
    }
  }

  writeEvent('done', {
    conversation_id: convId,
    message_id: messageId,
    full: fullText.trim(),
    sentences: sentenceSeq,
  });
  console.log(`[jarvis-voice/chat_tts_stream] [${requestId}] done conv=${convId} sentences=${sentenceSeq} chars=${fullText.length}`);
  res.end();
}

async function handleConversationStart(req, res, requestId, { tenant, jarvisUser }) {
  let body = {};
  try { body = await readJsonBody(req); } catch { /* allow empty */ }

  let deviceId = body.device_id || null;
  if (!deviceId && (body.device_label || body.user_agent)) {
    const dev = await sbPost('jarvis_devices', {
      tenant_id: tenant.id,
      user_id: jarvisUser.id,
      device_label: body.device_label || null,
      user_agent: body.user_agent || null,
      last_seen: new Date().toISOString(),
    });
    deviceId = dev[0].id;
  }

  // Resume an existing conversation if requested + still open.
  // DoD #66/#9 (conversation persistence): client passes resume_conversation_id
  // from localStorage on page load. Server verifies the conversation belongs
  // to this tenant + user + is not ended/deleted, then returns its messages.
  const resumeId = body.resume_conversation_id;
  if (resumeId && typeof resumeId === 'string') {
    try {
      const rows = await sbGet(
        `jarvis_conversations?select=id,tenant_id,user_id,ended_at,deleted_at,started_at,title&id=eq.${resumeId}&tenant_id=eq.${tenant.id}&limit=1`
      );
      const existing = rows && rows[0];
      if (existing && existing.user_id === jarvisUser.id && !existing.ended_at && !existing.deleted_at) {
        const messages = await sbGet(
          `jarvis_messages?select=id,role,content,created_at&conversation_id=eq.${existing.id}&order=created_at.asc&limit=200`
        );
        console.log(`[jarvis-voice/start] [${requestId}] resumed conv=${existing.id} (${messages.length} msgs)`);
        return res.status(200).json({
          ok: true,
          conversation_id: existing.id,
          device_id: deviceId,
          resumed: true,
          messages: (messages || []).map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content || '',
            created_at: m.created_at,
          })),
        });
      }
      // resume requested but not found or already closed — fall through to new
      console.log(`[jarvis-voice/start] [${requestId}] resume_conversation_id ${resumeId} not resumable; creating new`);
    } catch (err) {
      console.warn(`[jarvis-voice/start] [${requestId}] resume lookup failed: ${err.message}`);
    }
  }

  const conv = await sbPost('jarvis_conversations', {
    tenant_id: tenant.id,
    user_id: jarvisUser.id,
    device_id: deviceId,
    started_at: new Date().toISOString(),
  });

  console.log(`[jarvis-voice/start] [${requestId}] new conv=${conv[0].id}`);
  return res.status(200).json({ ok: true, conversation_id: conv[0].id, device_id: deviceId, resumed: false, messages: [] });
}

async function handleConversationEnd(req, res, requestId, { tenant }) {
  let body;
  try { body = await readJsonBody(req); } catch { return res.status(400).json({ ok: false, error: 'Invalid JSON' }); }
  const { conversation_id } = body || {};
  if (!conversation_id) return res.status(400).json({ ok: false, error: 'conversation_id required' });

  // Pull last N messages to summarize a title
  const messages = await sbGet(
    `jarvis_messages?select=role,content&conversation_id=eq.${conversation_id}&order=created_at.asc&limit=10`
  );
  let title = null;
  if (messages.length && ANTHROPIC_API_KEY) {
    try {
      const summaryRes = await withTimeout(
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 30,
            system: 'You generate a 4-7 word title summarizing the topic of a short conversation. Output the title only — no quotes, no punctuation at the end.',
            messages: [{
              role: 'user',
              content: messages.map((m) => `[${m.role}] ${(m.content || '').slice(0, 200)}`).join('\n'),
            }],
          }),
        }),
        5000,
        'TitleClaude'
      );
      if (summaryRes.ok) {
        const dat = await summaryRes.json();
        title = (dat.content?.[0]?.text || '').trim().slice(0, 80) || null;
      }
    } catch (err) {
      console.warn(`[jarvis-voice/end] [${requestId}] title summarization failed: ${err.message}`);
    }
  }

  await sbPatch(`jarvis_conversations?id=eq.${conversation_id}&tenant_id=eq.${tenant.id}`, {
    ended_at: new Date().toISOString(),
    title,
  });
  console.log(`[jarvis-voice/end] [${requestId}] conv=${conversation_id} title="${title || 'untitled'}"`);
  return res.status(200).json({ ok: true, title });
}

// ===== Entry =====
export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const op = String((req.query && req.query.op) || '').toLowerCase();
  const validOps = ['stt', 'chat', 'tts', 'chat_tts_stream', 'conversation_start', 'conversation_end'];
  if (!validOps.includes(op)) {
    return res.status(400).json({ ok: false, error: `Invalid ?op= (one of: ${validOps.join(', ')})` });
  }

  const requestId = `jv_${op}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  // Auth — required for all ops
  let authUser;
  try {
    authUser = await verifySupabaseToken(req);
  } catch (err) {
    if (err.status === 401) {
      return res.status(401).json({ ok: false, error: 'Not signed in' });
    }
    console.error(`[jarvis-voice] [${requestId}] auth error: ${err.message}`);
    return res.status(500).json({ ok: false, error: 'Auth failure' });
  }

  // Resolve tenant
  let context;
  try {
    context = await resolveTenant(authUser.userId);
  } catch (err) {
    console.error(`[jarvis-voice] [${requestId}] tenant resolve: ${err.message}`);
    return res.status(500).json({ ok: false, error: 'Tenant lookup failed' });
  }
  if (!context || !context.tenant) {
    return res.status(403).json({ ok: false, error: 'No Jarvis tenant for this user' });
  }

  try {
    switch (op) {
      case 'stt':
        return await handleSTT(req, res, requestId);
      case 'chat':
        return await handleChat(req, res, requestId, context);
      case 'tts':
        return await handleTTS(req, res, requestId, context);
      case 'chat_tts_stream':
        return await handleChatTTSStream(req, res, requestId, context);
      case 'conversation_start':
        return await handleConversationStart(req, res, requestId, context);
      case 'conversation_end':
        return await handleConversationEnd(req, res, requestId, context);
    }
  } catch (err) {
    console.error(`[jarvis-voice/${op}] [${requestId}] unhandled: ${err.message}\n${err.stack}`);
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: 'Server error', requestId });
    }
  }
}
