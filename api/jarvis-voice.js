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
import { buildToolSpecs, dispatchTool, logToolInvocation } from './_jarvis_tools.js';
import {
  embedText as memoryEmbedText,
  searchMemory as memorySearch,
  formatLessonsAsSystemBlock as memoryFormatBlock,
} from './_lib/agent-memory.js';

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
// ElevenLabs per-call hard limit is 5000 chars. Raised from 1200 on 2026-06-27
// after Heath pasted a long message and asked Jarvis to read it back — the
// 1200 cap silently truncated mid-sentence. Streaming chat_tts_stream already
// chunks by sentence so this only affects the legacy /op=tts endpoint, but
// 5000 keeps both paths honest.
const MAX_TTS_CHARS = 5000;
const STT_TIMEOUT_MS = 5000;     // DoD criterion 26
const TTS_TIMEOUT_MS = 8000;     // raised 2026-06-27 to handle longer payloads
const CHAT_TIMEOUT_MS = 30000;   // raised 2026-06-27 to allow longer Claude replies (max_tokens=4096)

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

When a tool call is appropriate (web search, send a message, read calendar, spawn an agent, etc.), name it explicitly in your reply so the wrapper can execute. For state-changing actions (send, purchase, submit), ALWAYS confirm verbally before firing: "${addressing.charAt(0).toUpperCase() + addressing.slice(1)}, I'm about to send X. Confirm?"

TOOL: spawn_agent (AGGRESSIVE AUTO-ROUTING — locked 2026-06-27)
You can queue async work for Heath's named agents (Carter, Atlas, Hadley, Pierce, Sage, Quinn, Ridge, Sterling) by calling the spawn_agent tool. Auto-route work requests to the right agent EVEN WHEN HEATH DOES NOT NAME THEM. Heath's old behavior of saying "Atlas, raise the TTS limit" was too narrow — when he just says "raise the TTS limit", that is still work and it still routes to Atlas.

Routing table (use even when Heath does not name the agent):
- fix / build / ship code, infra, deploy, schema, env vars, cron, performance, app fixes -> ATLAS
- product UI, React, dossier card, dashboard hero, frontend redesign -> CARTER drafts THEN ATLAS ships (chain with depends_on)
- draft a memo, legal risk, ToS, privacy policy, contract, compliance question with a deliverable -> HADLEY
- customer outreach email, activation, funnel, drip, churn save -> PIERCE
- social post, Instagram, LinkedIn, reel, video, content calendar entry -> SAGE
- QA test, Playwright sweep, verify a flow, sign-in test -> QUINN
- cron health, uptime, watchdog, KPI alert, SLO -> RIDGE
- stock, crypto, portfolio, rebalance, trade idea, market move check -> STERLING

Multi-agent chains in the SAME turn: when a request obviously needs two agents in sequence, spawn the first, capture its queue_id, then spawn the second with depends_on=[first_queue_id]. Example: "draft a memo on X and ship the schema" -> first spawn_agent(target=hadley, ...) -> read queue_id from result -> second spawn_agent(target=atlas, depends_on=[that_uuid], ...). Example: "test the new feature and merge if it passes" -> Quinn first, Atlas with depends_on second.

DO NOT spawn_agent for:
- Factual questions answerable from HUD or project_context ("how many founders do we have", "what's our MRR", "what's the TTS limit", "what does X integration cost") -> answer from context
- Status queries about agents ("what's Atlas working on", "where is Hadley on the memo") -> answer from HUD federation
- Casual / emotional chat ("how was the trip", "feeling tired today") -> respond conversationally
- Hypotheticals ("what would Hadley think") -> answer from context

When you spawn (single agent), confirm verbally with the routed agent name even if Heath did not name them: "Routing to Atlas — raise TTS limit, priority 2, ID [last 6 chars]. He'll pick it up in about two minutes."

When you spawn a chain, confirm both: "Routing to Hadley first to draft the memo, then to Atlas for the schema once Hadley is done. IDs [hadley_last_6] and [atlas_last_6]."

When the request is genuinely ambiguous (could be a question OR a work assignment — e.g., "what about X" with no clear verb), ask: "Want me to queue [agent] for this, or just answer from what I know?"

Intent examples (locked routing):
- "Atlas, raise the TTS limit" -> SPAWN atlas
- "raise the TTS limit" -> SPAWN atlas (new behavior — auto-route)
- "what's the TTS limit?" -> ANSWER from context, no spawn
- "Hadley, what's the legal risk on X" -> SPAWN hadley (deliverable implied)
- "what's the legal risk on X" -> SPAWN hadley (auto-route, deliverable implied)
- "draft a memo and ship the schema" -> SPAWN hadley THEN atlas with depends_on
- "how many founders do we have" -> ANSWER from context, no spawn
- "what's Atlas working on" -> ANSWER from HUD federation
- "build me a customer outreach email" -> SPAWN pierce
- "make a reel about Suzanne" -> SPAWN sage

TOOL: query_project_context
When Heath asks about a specific project, paused initiative, customer roster, or named decision that is NOT on your default HUD federation, call query_project_context with the relevant project_context keys (max 5 per call). Examples of when to use: "what's the status of the cold-email plan", "remind me about the Jarvis SaaS vault idea", "tell me about Suzanne's account". Skip when the answer is already in your HUD context or in plain conversational chat.`;
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

// Whitelist of Anthropic-supported image mime types (Build A 2026-06-25).
function sanitizeImageMediaType(mime) {
  const m = String(mime || '').toLowerCase().trim();
  if (m === 'image/jpeg' || m === 'image/jpg') return 'image/jpeg';
  if (m === 'image/png') return 'image/png';
  if (m === 'image/gif') return 'image/gif';
  if (m === 'image/webp') return 'image/webp';
  return null;
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

// Fire-and-forget debug row. Best-effort; never throws.
async function logSttDebug(row) {
  try {
    await sbPost('jarvis_stt_debug', row, { prefer: 'return=minimal' });
  } catch (e) {
    console.warn(`[jarvis-voice/stt] debug log failed: ${e.message}`);
  }
}

// Send the audio buffer to ElevenLabs with a chosen filename hint.
// Returns { ok, status, transcript, errText, elMs }.
async function callElevenLabsSTT(audioBuffer, contentType, filenameHint) {
  const form = new FormData();
  form.append('model_id', 'scribe_v1');
  const blob = new Blob([audioBuffer], { type: contentType });
  form.append('file', blob, filenameHint);
  const t0 = Date.now();
  let res;
  try {
    res = await withTimeout(
      fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_API_KEY },
        body: form,
      }),
      STT_TIMEOUT_MS,
      'ElevenLabsSTT'
    );
  } catch (err) {
    return { ok: false, status: 0, transcript: '', errText: err.message || 'fetch_error', elMs: Date.now() - t0 };
  }
  const elMs = Date.now() - t0;
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { ok: false, status: res.status, transcript: '', errText: errText.slice(0, 400), elMs };
  }
  let transcript = '';
  try {
    const data = await res.json();
    transcript = String((data && data.text) || '').trim();
  } catch (err) {
    return { ok: false, status: res.status, transcript: '', errText: 'parse_error', elMs };
  }
  return { ok: true, status: 200, transcript, errText: '', elMs };
}

// OpenAI Whisper fallback. Returns same shape as callElevenLabsSTT.
async function callWhisperSTT(audioBuffer, contentType, filenameHint) {
  if (!OPENAI_API_KEY) {
    return { ok: false, status: 0, transcript: '', errText: 'no_openai_key', elMs: 0 };
  }
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('response_format', 'json');
  const blob = new Blob([audioBuffer], { type: contentType });
  form.append('file', blob, filenameHint);
  const t0 = Date.now();
  let res;
  try {
    res = await withTimeout(
      fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: form,
      }),
      STT_TIMEOUT_MS,
      'WhisperSTT'
    );
  } catch (err) {
    return { ok: false, status: 0, transcript: '', errText: err.message || 'fetch_error', elMs: Date.now() - t0 };
  }
  const elMs = Date.now() - t0;
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { ok: false, status: res.status, transcript: '', errText: errText.slice(0, 400), elMs };
  }
  let transcript = '';
  try {
    const data = await res.json();
    transcript = String((data && data.text) || '').trim();
  } catch (err) {
    return { ok: false, status: res.status, transcript: '', errText: 'parse_error', elMs };
  }
  return { ok: true, status: 200, transcript, errText: '', elMs };
}

async function handleSTT(req, res, requestId, authUser) {
  // ElevenLabs Speech-to-Text (scribe_v1) — replaced OpenAI Whisper 2026-06-20
  // after the OpenAI account hit insufficient_quota (429) bouncing every
  // Heath recording as "Provider error". ElevenLabs key reused from TTS path.
  //
  // 2026-06-26 (Atlas overnight loop): added jarvis_stt_debug row write + Whisper
  // retry fallback + filename-coerce retry. Symptom under investigation: Android
  // WebView in Capacitor APK occasionally produces an audio container ElevenLabs
  // rejects with 400, surfacing client-side as "I didn't catch that — try again."
  const startMs = Date.now();
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 240);
  const authUserId = (authUser && authUser.userId) || null;

  if (!ELEVENLABS_API_KEY) {
    await logSttDebug({
      request_id: requestId, auth_user_id: authUserId, user_agent: userAgent,
      content_type: req.headers['content-type'] || '', byte_size: 0, magic_hex: '',
      el_status: 0, el_error_text: 'STT not configured', transcript_preview: '',
      outcome: 'no_key', total_ms: Date.now() - startMs, el_ms: 0,
    });
    return res.status(503).json({ ok: false, error: 'STT not configured' });
  }
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('audio/')) {
    await logSttDebug({
      request_id: requestId, auth_user_id: authUserId, user_agent: userAgent,
      content_type: contentType, byte_size: 0, magic_hex: '',
      el_status: 0, el_error_text: '', transcript_preview: '',
      outcome: 'bad_content_type', total_ms: Date.now() - startMs, el_ms: 0,
    });
    return res.status(400).json({ ok: false, error: `Expected audio/* Content-Type, got "${contentType}"` });
  }

  let audioBuffer;
  try {
    audioBuffer = await readRawBody(req, MAX_AUDIO_BYTES);
  } catch (err) {
    if (err.code === 'PAYLOAD_TOO_LARGE') {
      await logSttDebug({
        request_id: requestId, auth_user_id: authUserId, user_agent: userAgent,
        content_type: contentType, byte_size: -1, magic_hex: '',
        el_status: 0, el_error_text: '', transcript_preview: '',
        outcome: 'payload_too_large', total_ms: Date.now() - startMs, el_ms: 0,
      });
      return res.status(413).json({ ok: false, error: 'Audio too large' });
    }
    throw err;
  }

  // Capture first 12 bytes as hex for codec identification.
  // webm: 1A 45 DF A3 (EBML)
  // mp4:  ?? ?? ?? ?? 66 74 79 70 (ftyp at offset 4)
  // ogg:  4F 67 67 53
  // wav:  52 49 46 46 ... 57 41 56 45
  const magicHex = audioBuffer.length >= 12
    ? audioBuffer.slice(0, 12).toString('hex')
    : audioBuffer.toString('hex');

  if (audioBuffer.length === 0) {
    await logSttDebug({
      request_id: requestId, auth_user_id: authUserId, user_agent: userAgent,
      content_type: contentType, byte_size: 0, magic_hex: '',
      el_status: 0, el_error_text: '', transcript_preview: '',
      outcome: 'empty_payload', total_ms: Date.now() - startMs, el_ms: 0,
    });
    return res.status(400).json({ ok: false, error: 'audio_empty_or_too_short', detail: 'Empty audio payload' });
  }
  if (audioBuffer.length < MIN_AUDIO_BYTES) {
    console.log(`[jarvis-voice/stt] [${requestId}] short audio ${audioBuffer.length}b — skipping STT`);
    await logSttDebug({
      request_id: requestId, auth_user_id: authUserId, user_agent: userAgent,
      content_type: contentType, byte_size: audioBuffer.length, magic_hex: magicHex,
      el_status: 0, el_error_text: '', transcript_preview: '',
      outcome: 'too_short_client', total_ms: Date.now() - startMs, el_ms: 0,
    });
    return res.status(400).json({ ok: false, error: 'audio_empty_or_too_short', bytes: audioBuffer.length });
  }

  const baseMime = contentType.split(';')[0].trim();
  const filename1 = filenameForMime(baseMime);
  console.log(`[jarvis-voice/stt] [${requestId}] ${audioBuffer.length} bytes (${baseMime}) magic=${magicHex.slice(0, 16)} -> ElevenLabs scribe_v1`);

  // Attempt 1 — ElevenLabs with content-type-matched filename
  let attempt = await callElevenLabsSTT(audioBuffer, baseMime, filename1);
  let attemptLabel = 'el_primary';

  // Attempt 2 — if EL rejected with 400 (likely container/decoder issue),
  // retry with a different filename hint. Some EL paths sniff the file by
  // extension, not Content-Type — this can recover when the container is
  // valid but mistyped (Android WebView labels mp4 as webm in some OEMs).
  if (!attempt.ok && attempt.status === 400) {
    const altFilename = filename1 === 'audio.webm' ? 'audio.mp4' : 'audio.webm';
    console.warn(`[jarvis-voice/stt] [${requestId}] EL 400 on filename=${filename1}, retrying as ${altFilename}`);
    const retry = await callElevenLabsSTT(audioBuffer, baseMime, altFilename);
    if (retry.ok) {
      attempt = retry;
      attemptLabel = 'el_filename_retry';
    } else {
      // Attempt 3 — Whisper fallback
      console.warn(`[jarvis-voice/stt] [${requestId}] EL 400 on both filenames, falling back to Whisper`);
      const whisper = await callWhisperSTT(audioBuffer, baseMime, filename1);
      if (whisper.ok) {
        attempt = whisper;
        attemptLabel = 'whisper_fallback';
      } else {
        // Still failed. Use the original EL error for the user response.
        attempt = retry; // keep retry's errText for logging
        attemptLabel = `el_400_whisper_${whisper.status || 'err'}`;
      }
    }
  }

  if (attempt.ok) {
    console.log(`[jarvis-voice/stt] [${requestId}] (${attemptLabel}) "${attempt.transcript.slice(0, 80)}"`);
    await logSttDebug({
      request_id: requestId, auth_user_id: authUserId, user_agent: userAgent,
      content_type: contentType, byte_size: audioBuffer.length, magic_hex: magicHex,
      el_status: attempt.status, el_error_text: '',
      transcript_preview: attempt.transcript.slice(0, 200),
      outcome: `ok_${attemptLabel}`, total_ms: Date.now() - startMs, el_ms: attempt.elMs,
    });
    return res.status(200).json({ ok: true, transcript: attempt.transcript, empty: !attempt.transcript });
  }

  // All providers failed
  console.error(`[jarvis-voice/stt] [${requestId}] STT failed status=${attempt.status} attempt=${attemptLabel} err="${attempt.errText.slice(0, 200)}"`);
  await logSttDebug({
    request_id: requestId, auth_user_id: authUserId, user_agent: userAgent,
    content_type: contentType, byte_size: audioBuffer.length, magic_hex: magicHex,
    el_status: attempt.status, el_error_text: attempt.errText.slice(0, 400),
    transcript_preview: '', outcome: `fail_${attemptLabel}`,
    total_ms: Date.now() - startMs, el_ms: attempt.elMs,
  });

  if (attempt.status === 0 && /timed out/i.test(attempt.errText)) {
    return res.status(504).json({ ok: false, error: 'STT timeout', fallback: 'retry' });
  }
  if (attempt.status === 400) {
    return res.status(400).json({ ok: false, error: 'audio_empty_or_too_short', detail: attempt.errText.slice(0, 200) });
  }
  return res.status(502).json({ ok: false, error: 'STT provider error', status: attempt.status });
}

// Per-instance cache of context extensions (TTL 60s) to avoid re-loading on
// every turn within a conversation.
const _contextExtensionCache = new Map();
const CTX_TTL_MS = 60 * 1000;

async function fetchEnabledToolNames(tenantId) {
  try {
    const rows = await sbGet(
      `jarvis_tools?select=tool_name,enabled&tenant_id=eq.${tenantId}&enabled=eq.true`
    );
    return (rows || []).map((r) => r.tool_name);
  } catch (err) {
    console.warn(`[jarvis-voice/chat] enabled-tools lookup failed: ${err.message}`);
    return [];
  }
}

// ===== Temporal + location context =====
// Built per-turn (NOT cached) so date/time is always current. Heath asked
// "what day is it" mid-flight 2026-06-21 and Jarvis answered "Monday June 23"
// — the cached system prompt had drifted. Fix: prepend a non-cached block
// every chat turn with server time + tenant timezone hint + known travel
// itinerary lookup. Locked 2026-06-21.
function getKnownLocationForHeath(now) {
  // Heath's itinerary memory `project_chamonix_trip_june_2026.md`:
  //   2026-06-21 23:01 CST: en route IAH -> CDG (Paris)
  //   2026-06-22..28: Paris + Provence
  //   2026-06-29..07-02: Chamonix (Les Praz/Argentière)
  //   After 2026-07-02: returning to San Antonio
  const t = now.getTime();
  const day = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getTime();
  if (t >= day(2026, 6, 21) && t < day(2026, 6, 22)) {
    return 'en route IAH -> CDG (Paris). On board a transatlantic flight as of last known check-in.';
  }
  if (t >= day(2026, 6, 22) && t < day(2026, 6, 29)) {
    return 'Paris / Provence, France (family trip leg 1). Europe Central Summer time (CEST, UTC+2).';
  }
  if (t >= day(2026, 6, 29) && t < day(2026, 7, 3)) {
    return 'Chamonix-Mont-Blanc, France (Les Praz / Argentière area). CEST, UTC+2.';
  }
  if (t >= day(2026, 7, 3)) {
    return 'San Antonio, Texas (home). America/Chicago (CST/CDT).';
  }
  return 'San Antonio, Texas (default home base). America/Chicago.';
}

function buildLiveTemporalBlock(tenant, clientCtx) {
  const now = new Date();
  // Prefer client-provided timezone (browser TZ), fall back to Heath default
  const tz = (clientCtx && typeof clientCtx.timezone === 'string' && clientCtx.timezone) ||
             (tenant && tenant.slug === 'heath' ? 'America/Chicago' : 'UTC');
  let localStr = '';
  try {
    localStr = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(now);
  } catch {
    localStr = now.toISOString();
  }
  const isoUtc = now.toISOString();

  // Location: prefer client-supplied (if Heath ever wires geolocation), else
  // fall back to itinerary lookup for Heath, else last-known for tenant.
  let location = '';
  if (clientCtx && typeof clientCtx.location === 'string' && clientCtx.location.trim()) {
    location = clientCtx.location.trim();
  } else if (tenant && tenant.slug === 'heath') {
    location = getKnownLocationForHeath(now);
  } else {
    location = 'Unknown — ask the user if relevant.';
  }

  const lines = [
    '=== LIVE TEMPORAL CONTEXT (authoritative, refreshed every turn) ===',
    `Current date and time: ${localStr}`,
    `Current UTC: ${isoUtc}`,
    `User timezone: ${tz}`,
    `User likely location: ${location}`,
    'These four lines are authoritative. If the user asks "what day is it", "where am I",',
    'or "what time is it", use these values verbatim. Do NOT guess, do NOT contradict.',
    '=== END LIVE TEMPORAL CONTEXT ===',
  ];
  return lines.join('\n');
}

// Static UI capability block — describes what the PWA actually exposes so
// Jarvis can self-explain accurately when Heath asks "what can I do here"
// or "if I text will you reply by voice". Locked 2026-06-21.
const PWA_UI_CAPABILITIES = `=== JARVIS PWA UI CAPABILITIES ===
The user is talking to you through the Jarvis PWA at meetdossie.com/myjarvis.
The PWA exposes the following surfaces (be accurate when asked):
- Voice input: tap the central mic / Earth-globe button once to start a continuous conversation. The mic stays held via VAD (Voice Activity Detection); each pause auto-cuts an utterance and submits it. Tap a second time to end the conversation.
- Text input: a chat dock with a text field. Send messages by Enter or the send button. A Voice/Text reply toggle (persisted per device in localStorage) controls whether Jarvis responds with TTS audio + transcript (Voice) or text only (Text).
- File attachments: paperclip icon in the chat dock — image/audio/PDF upload.
- Quick Action chips: above the central orb (Morning Brief, MRR, Pending Approvals, Daily Debrief, etc.). One tap fires that flow.
- Voice Brief button: a ~60-second audio briefing in George voice.
- HUD panels (Tier 1 + Tier 2): Calendar, Ask a Specialist (Hadley / Sterling / Pierce / Sage / Quinn / Ridge / Carter / Atlas), Pending Approvals, Daily Debrief, Customer Activity, Open Todo, Money Pulse, Agent Status, Activity Log, Session Log.
- Globe / Earth wireframe with city lights rotates behind the mic button at all times.
- Noisy Environment toggle: top-right of the mic area. When ON, the VAD threshold is raised and short ambient noises (cabin noise, music, buzzing) are filtered out as non-speech.

When the user asks about what they can do in the app, describe these accurately. Do NOT invent panels that don't exist. Do NOT say "that depends on the interface" — you ARE in this interface.

VISION (image attachments):
If Heath attaches an image, describe what you see and respond to his question about it. Reference specifics from the image — text, numbers, layouts, dates, names, prices, error messages. Do not say "I can't see images" — you absolutely can. Speak the answer cleanly for TTS: full sentences, no markdown.
=== END JARVIS PWA UI CAPABILITIES ===`;

async function getContextExtension(tenant) {
  const key = `ctx:${tenant.id}`;
  const hit = _contextExtensionCache.get(key);
  if (hit && (Date.now() - hit.at) < CTX_TTL_MS) return hit.text;
  // Inline call to the context-load logic via a local fetch is wasteful;
  // instead we lazy-load the same generator. For now, simply build a compact
  // live block inline (full backbone lives in /api/jarvis-context-load which
  // the client can call separately at conversation_start). For chat turns we
  // only need the live, fast-moving state.
  try {
    const [todoRows, agentEvents, subRows] = await Promise.all([
      sbGet('heath_todo?select=title,priority,deadline,status,venture&status=in.(pending,snoozed)&order=priority.desc.nullslast&limit=10').catch(() => []),
      // Fetch up to 20 recent events so we can group by agent + present in-progress vs completed.
      sbGet(`jarvis_agent_events?select=agent_name,event_type,summary,created_at&tenant_id=eq.${tenant.id}&order=created_at.desc&limit=20`).catch(() => []),
      sbGet('subscriptions?select=id&status=eq.active').catch(() => []),
    ]);
    const lines = [
      '=== LIVE STATE (refreshed) ===',
      `Active subscribers: ${subRows.length}. Estimated MRR: $${subRows.length * 29}/mo.`,
    ];
    if (todoRows.length) {
      lines.push('Open todo (top 10):');
      for (const t of todoRows) {
        const p = t.priority != null ? `[P${t.priority}]` : '';
        const d = t.deadline ? ` due ${String(t.deadline).slice(0, 10)}` : '';
        const v = t.venture ? ` (${t.venture})` : '';
        lines.push(`  - ${p} ${t.title}${d}${v}`);
      }
    }
    // Improved agent activity formatting: per-agent latest event + age
    // ("Atlas (working 12m ago): ..."). Lets Jarvis answer "what are agents
    // doing" without a query_supabase call. Bug fix 2026-06-21.
    if (agentEvents.length) {
      const latest = {};
      for (const ev of agentEvents) { if (!latest[ev.agent_name]) latest[ev.agent_name] = ev; }
      lines.push('');
      lines.push('LIVE AGENT ACTIVITY (latest event per agent, most-recent first):');
      const sorted = Object.entries(latest).sort(([, a], [, b]) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      const now = Date.now();
      for (const [agent, ev] of sorted) {
        const ageMs = Math.max(0, now - new Date(ev.created_at).getTime());
        const ageMin = Math.round(ageMs / 60000);
        const ageStr = ageMin < 1 ? 'just now' : ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;
        lines.push(`  - ${agent} (${ev.event_type}, ${ageStr}): ${(ev.summary || '').slice(0, 140)}`);
      }
    } else {
      lines.push('');
      lines.push('LIVE AGENT ACTIVITY: no recent agent events on record.');
    }
    lines.push('=== END LIVE STATE ===');
    const text = lines.join('\n');
    _contextExtensionCache.set(key, { at: Date.now(), text });
    return text;
  } catch (err) {
    console.warn(`[jarvis-voice/chat] context build failed: ${err.message}`);
    return '';
  }
}

// ---------------------------------------------------------------------------
// HUD STATE CONTEXT — pulls live state from 7 sources so Jarvis can answer
// "what's on my future builds", "what's hadley_1 doing", "did anything ship
// today" conversationally. Locked 2026-06-25 after Heath flagged: "Jarvis
// also doesn't seem to know what's on his future builds. When I ask him
// about something that's on there he doesn't know what I'm talking about."
//
// This is rebuilt PER TURN (no cache) and appended to the DYNAMIC suffix of
// the system prompt (NOT cached). Sits BEFORE the existing temporal/live
// context so Jarvis sees it first. Failure of any single query is logged +
// skipped, never blocks the turn.
//
// Cost: ~1-2k input tokens per turn. With the stable prefix cached (~85%
// discount on persona + PWA caps), net cost diff is ~$0.003 per voice turn
// on Sonnet 4.6 — negligible at Heath's volume (~200 turns/day = $0.60/day).
// ---------------------------------------------------------------------------
const HUD_CTX_MAX_CHARS = 12000; // ~3000 tokens

// Atlas 2026-06-27 (Lever B latency): when buildHudStateContext is called
// with { compact: true }, limits drop and the heavy codebase_facts section
// is skipped entirely. Used for short voice utterances where prompt size
// dominates Anthropic TTFT. Empirically: full HUD = ~3-4k input tokens,
// compact HUD = ~700-1000 input tokens. Saves ~150-300ms TTFT.
async function buildHudStateContext(tenant, opts = {}) {
  if (!tenant || !tenant.id) return '';
  const startedAt = Date.now();
  const sections = [];
  const compact = !!opts.compact;
  // Limits — full vs compact mode.
  const FB_LIMIT = compact ? 5 : 25;
  const INST_LIMIT = compact ? 5 : 20;
  const PROJ_LIMIT = compact ? 10 : 50;
  const ROLE_MEM_LIMIT = compact ? 200 : 2000;
  const QUEUE_LIMIT = compact ? 200 : 2000;
  const SHIPPED_LIMIT = compact ? 3 : 10;
  const TODO_LIMIT = compact ? 5 : 10;
  const COMPLETIONS_LIMIT = compact ? 0 : 5;
  const PROJCTX_LIMIT = compact ? 3 : 12;
  const SKIP_CODEBASE_FACTS = compact; // codebase facts dropped entirely in compact

  // SCHEMA QUIRK: jarvis_future_builds.tenant_id actually stores the auth.users.id
  // (per api/jarvis-future-builds-list.js line 51: .eq('tenant_id', auth.user_id)).
  // It does NOT store tenants.id. So to find a tenant's builds we have to look up
  // ALL auth_user_ids belonging to this tenant and OR-match them. Heath has two
  // auth_user_ids (heath@meetdossie.com + heath.shepard@kw.com), only one of
  // which the future-builds reconciler writes to.
  let authUserIds = [];
  try {
    const ju = await sbGet(`jarvis_users?select=auth_user_id&tenant_id=eq.${tenant.id}`);
    authUserIds = (ju || []).map((r) => r.auth_user_id).filter(Boolean);
  } catch (e) {
    console.warn(`[hud-ctx] auth_user_ids lookup: ${e.message}`);
  }
  const fbTenantFilter = authUserIds.length
    ? `tenant_id=in.(${authUserIds.join(',')})`
    : `tenant_id=eq.${tenant.id}`;

  // Run all queries in parallel. Each gets its own try/catch in the .catch.
  const [
    futureBuilds,
    runningInstances,
    projects,
    knowledgeCounts,
    queueCounts,
    recentShipped,
    openTodo,
    recentCompletions,
    projectContext,
    codebaseFacts,
  ] = await Promise.all([
    sbGet(
      `jarvis_future_builds?select=title,status,score,source&${fbTenantFilter}&archived_at=is.null&order=score.desc.nullslast,updated_at.desc&limit=${FB_LIMIT}`
    ).catch((e) => { console.warn(`[hud-ctx] future_builds: ${e.message}`); return []; }),
    sbGet(
      `jarvis_agent_instances?select=instance_id,agent_role,project_id,spawned_at,metadata&tenant_id=eq.${tenant.id}&status=eq.running&order=spawned_at.desc&limit=${INST_LIMIT}`
    ).catch((e) => { console.warn(`[hud-ctx] agent_instances: ${e.message}`); return []; }),
    sbGet(
      `jarvis_projects?select=id,title,status,metadata&tenant_id=eq.${tenant.id}&order=updated_at.desc&limit=${PROJ_LIMIT}`
    ).catch((e) => { console.warn(`[hud-ctx] projects: ${e.message}`); return []; }),
    // Knowledge counts grouped client-side from a single select
    sbGet(
      `agent_role_memory?select=agent_role&tenant_id=eq.${tenant.id}&validation_status=neq.archived&limit=${ROLE_MEM_LIMIT}`
    ).catch((e) => { console.warn(`[hud-ctx] role_memory: ${e.message}`); return []; }),
    sbGet(
      `agent_queue?select=status&limit=${QUEUE_LIMIT}`
    ).catch((e) => { console.warn(`[hud-ctx] agent_queue: ${e.message}`); return []; }),
    // Recently shipped (last 24h) — same auth_user_id quirk as future_builds.
    // Match on updated_at OR archived_at so manually-backfilled rows that set
    // archived_at without bumping updated_at, or vice-versa, still surface.
    sbGet(
      `jarvis_future_builds?select=title,status,updated_at,archived_at&${fbTenantFilter}&status=eq.shipped&or=(updated_at.gt.${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()},archived_at.gt.${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()})&order=updated_at.desc&limit=${SHIPPED_LIMIT}`
    ).catch((e) => { console.warn(`[hud-ctx] shipped: ${e.message}`); return []; }),
    sbGet(
      `heath_todo?select=title,priority,deadline,status,venture&status=in.(pending,snoozed)&order=priority.desc.nullslast,created_at.desc&limit=${TODO_LIMIT}`
    ).catch((e) => { console.warn(`[hud-ctx] heath_todo: ${e.message}`); return []; }),
    // In compact mode, COMPLETIONS_LIMIT=0 → skip the call (return [] immediately)
    COMPLETIONS_LIMIT > 0
      ? sbGet(
          `jarvis_agent_events?select=agent_name,event_type,summary,created_at&tenant_id=eq.${tenant.id}&event_type=in.(instance-closed,item-completed)&created_at=gt.${new Date(Date.now() - 60 * 60 * 1000).toISOString()}&order=created_at.desc&limit=${COMPLETIONS_LIMIT}`
        ).catch((e) => { console.warn(`[hud-ctx] completions: ${e.message}`); return []; })
      : Promise.resolve([]),
    // PROJECT CONTEXT (atlas_12 2026-06-26): strategic projects + paused
    // initiatives + decisions Jarvis must speak about correctly. Mirrors
    // filesystem memory files in ~/.claude/projects/<repo>/memory/. Filter:
    // status active/paused/blocked (skip shipped/archived). Skip rows past
    // expires_at. Order: priority asc (1 = top), then last_updated_at desc.
    // Compact mode = top 3 (only highest-priority strategic context).
    sbGet(
      `jarvis_project_context?select=key,title,summary,status,priority,tags,last_updated_at,expires_at` +
      `&tenant_id=eq.${tenant.id}` +
      `&status=in.(active,paused,blocked)` +
      `&or=(expires_at.is.null,expires_at.gt.${encodeURIComponent(new Date().toISOString())})` +
      `&order=priority.asc,last_updated_at.desc&limit=${PROJCTX_LIMIT}`
    ).catch((e) => { console.warn(`[hud-ctx] project_context: ${e.message}`); return []; }),
    // CODEBASE FACTS (atlas 2026-06-27): live auto-indexed inventory of what
    // exists in the MeetDossie repo. Updated every 6h by
    // cron-codebase-facts-indexer. Compact mode skips entirely — short queries
    // rarely ask "does X exist", and codebase facts are the biggest section.
    SKIP_CODEBASE_FACTS
      ? Promise.resolve([])
      : sbGet(
          `codebase_facts?select=category,fact_key,fact_value` +
          `&tenant_id=eq.${tenant.id}` +
          `&is_active=eq.true` +
          `&category=in.(legal-pages,feature-capabilities,vercel-config)` +
          `&order=category.asc,fact_key.asc&limit=60`
        ).catch((e) => { console.warn(`[hud-ctx] codebase_facts: ${e.message}`); return []; }),
  ]);

  // ===== Section 1: FUTURE BUILDS panel (grouped by status) =====
  if (futureBuilds && futureBuilds.length) {
    const grouped = {};
    for (const fb of futureBuilds) {
      const s = (fb.status || 'idea').toLowerCase();
      if (!grouped[s]) grouped[s] = [];
      grouped[s].push(fb);
    }
    const lines = [`### FUTURE BUILDS panel (${futureBuilds.length} items, top by score)`];
    // Order: building, dod-drafting, in-progress, idea, then anything else
    const order = ['building', 'dod-drafting', 'in-progress', 'in_progress', 'idea'];
    const seen = new Set();
    for (const status of order) {
      if (!grouped[status]) continue;
      seen.add(status);
      lines.push(`- ${status.toUpperCase()}:`);
      for (const item of grouped[status]) {
        const src = item.source ? ` (${item.source})` : '';
        const sc = item.score != null ? `, score ${item.score}` : '';
        lines.push(`  - ${item.title}${sc}${src}`);
      }
    }
    for (const status of Object.keys(grouped)) {
      if (seen.has(status)) continue;
      lines.push(`- ${status.toUpperCase()}:`);
      for (const item of grouped[status]) {
        const src = item.source ? ` (${item.source})` : '';
        const sc = item.score != null ? `, score ${item.score}` : '';
        lines.push(`  - ${item.title}${sc}${src}`);
      }
    }
    sections.push(lines.join('\n'));
  } else {
    sections.push('### FUTURE BUILDS panel\n- (no items currently on the panel)');
  }

  // ===== Section 2: AGENT STATUS (running instances + project link) =====
  if (runningInstances && runningInstances.length) {
    const projById = {};
    for (const p of (projects || [])) projById[p.id] = p;
    const lines = [`### AGENT STATUS (${runningInstances.length} instance${runningInstances.length === 1 ? '' : 's'} running)`];
    const now = Date.now();
    for (const inst of runningInstances) {
      const proj = inst.project_id ? projById[inst.project_id] : null;
      const projTitle = proj ? proj.title : 'unassigned';
      // Checklist progress from project metadata if present
      let progress = '';
      try {
        const meta = proj && proj.metadata;
        const checklist = meta && (meta.checklist || meta.items);
        if (Array.isArray(checklist) && checklist.length) {
          const done = checklist.filter((c) => c && (c.done || c.completed || c.status === 'done')).length;
          progress = ` — ${done}/${checklist.length} done`;
        }
      } catch { /* ignore */ }
      const ageMs = Math.max(0, now - new Date(inst.spawned_at).getTime());
      const ageH = Math.round(ageMs / 3600000);
      const ageStr = ageH < 1 ? '<1h' : ageH < 48 ? `${ageH}h` : `${Math.round(ageH / 24)}d`;
      lines.push(`- ${inst.instance_id} (${inst.agent_role}) — ${projTitle}${progress} — running ${ageStr}`);
    }
    sections.push(lines.join('\n'));
  } else {
    sections.push('### AGENT STATUS\n- (no instances currently running)');
  }

  // ===== Section 3: AGENT QUEUE =====
  if (queueCounts && queueCounts.length) {
    const counts = {};
    for (const q of queueCounts) {
      const s = q.status || 'unknown';
      counts[s] = (counts[s] || 0) + 1;
    }
    const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`);
    sections.push(`### AGENT QUEUE\n- ${parts.join(', ')}`);
  }

  // ===== Section 4: AGENT KNOWLEDGE counts =====
  if (knowledgeCounts && knowledgeCounts.length) {
    const counts = {};
    for (const k of knowledgeCounts) {
      const r = k.agent_role || 'unknown';
      counts[r] = (counts[r] || 0) + 1;
    }
    const total = knowledgeCounts.length;
    const sorted = Object.entries(counts).sort(([, a], [, b]) => b - a);
    const parts = sorted.map(([role, n]) => `${role.charAt(0).toUpperCase() + role.slice(1)}: ${n}`);
    sections.push(`### AGENT KNOWLEDGE (${total} lessons total)\n- ${parts.join(', ')}`);
  }

  // ===== Section 5: Recent shipped (last 24h) =====
  if (recentShipped && recentShipped.length) {
    const lines = ['### Recent shipped (last 24h)'];
    for (const s of recentShipped) {
      const d = s.updated_at ? String(s.updated_at).slice(0, 10) : '';
      lines.push(`- ${d} ${s.title}`);
    }
    sections.push(lines.join('\n'));
  }

  // ===== Section 6: Heath's open todo =====
  if (openTodo && openTodo.length) {
    const lines = [`### Heath's open todo (${openTodo.length} item${openTodo.length === 1 ? '' : 's'})`];
    for (const t of openTodo) {
      const p = t.priority != null ? `[P${t.priority}] ` : '';
      const d = t.deadline ? ` (due ${String(t.deadline).slice(0, 10)})` : '';
      const v = t.venture ? ` [${t.venture}]` : '';
      lines.push(`- ${p}${t.title}${d}${v}`);
    }
    sections.push(lines.join('\n'));
  }

  // ===== Section 7: Recent agent completions (last 60min) =====
  if (recentCompletions && recentCompletions.length) {
    const lines = ['### Recent agent completions (last 60 min)'];
    const now = Date.now();
    for (const ev of recentCompletions) {
      const ageMs = Math.max(0, now - new Date(ev.created_at).getTime());
      const ageMin = Math.round(ageMs / 60000);
      const ageStr = ageMin < 1 ? 'just now' : `${ageMin}m ago`;
      lines.push(`- ${ev.agent_name} (${ageStr}): ${(ev.summary || ev.event_type || '').slice(0, 140)}`);
    }
    sections.push(lines.join('\n'));
  }

  // ===== Section 8: PROJECT CONTEXT (atlas_12 2026-06-26) =====
  // Strategic projects, paused initiatives, and locked decisions Jarvis must
  // speak about correctly. Mirrors filesystem memory files. Format per row:
  //   - **{title}** ({status}, p{priority}): {summary}
  // This section gives Jarvis the "did Heath pause that" / "what's the status of
  // X" answers without hallucinating.
  if (projectContext && projectContext.length) {
    const lines = [
      `## PROJECT CONTEXT (live, ${projectContext.length} item${projectContext.length === 1 ? '' : 's'})`,
      '(Strategic projects, paused initiatives, and locked decisions. When Heath asks about any of these, USE THE SUMMARY VERBATIM — never say "I don\'t know" if a row below matches.)',
    ];
    for (const ctx of projectContext) {
      const title = (ctx.title || ctx.key || '').slice(0, 120);
      const status = (ctx.status || 'active').toUpperCase();
      const pri = ctx.priority != null ? `p${ctx.priority}` : 'p?';
      const summary = (ctx.summary || '').replace(/\s+/g, ' ').trim();
      lines.push(`- **${title}** (${status}, ${pri}): ${summary}`);
    }
    sections.push(lines.join('\n'));
  }

  // ===== Section 9: CODEBASE TRUTH (atlas 2026-06-27) =====
  // Live auto-indexed inventory. Stops Jarvis from claiming "we have no PP"
  // when privacy.html ships in prod. Grouped by category. Each fact_value is
  // a small JSON object — extract exists + path + summary to keep tokens
  // bounded.
  if (codebaseFacts && codebaseFacts.length) {
    const byCat = {};
    for (const f of codebaseFacts) {
      const c = f.category || 'other';
      if (!byCat[c]) byCat[c] = [];
      byCat[c].push(f);
    }
    const lines = [
      '## CODEBASE TRUTH (live, auto-indexed every 6h)',
      '(What actually exists in the MeetDossie repo at HEAD. If a row below says exists=true, IT EXISTS — do not propose building it. If Heath asks "do we have a privacy policy" and you see privacy-policy-page exists=true here, the answer is YES.)',
    ];
    const catOrder = ['legal-pages', 'feature-capabilities', 'vercel-config'];
    const seen = new Set();
    for (const cat of catOrder) {
      if (!byCat[cat]) continue;
      seen.add(cat);
      lines.push(`### ${cat}`);
      for (const f of byCat[cat]) {
        const v = f.fact_value || {};
        const exists = v.exists === false ? 'MISSING' : 'exists';
        const where = v.route || v.path || v.location || v.file || '';
        const extra = v.line_count ? ` (${v.line_count} lines)` : '';
        lines.push(`- ${f.fact_key} — ${exists}${where ? `: ${where}` : ''}${extra}`);
      }
    }
    for (const cat of Object.keys(byCat)) {
      if (seen.has(cat)) continue;
      lines.push(`### ${cat}`);
      for (const f of byCat[cat]) {
        const v = f.fact_value || {};
        const exists = v.exists === false ? 'MISSING' : 'exists';
        const where = v.route || v.path || v.location || v.file || '';
        lines.push(`- ${f.fact_key} — ${exists}${where ? `: ${where}` : ''}`);
      }
    }
    sections.push(lines.join('\n'));
  }

  if (sections.length === 0) return '';

  const header =
    '=== CURRENT HUD STATE (live, fresh this turn — when Heath asks about his future builds, agents, todo, or recent ships, USE THIS DATA verbatim, do not say "I do not know" if a relevant row is below) ===';
  let body = sections.join('\n\n');

  // Cap total size — truncate longest section's content if over the limit.
  if (body.length > HUD_CTX_MAX_CHARS) {
    body = body.slice(0, HUD_CTX_MAX_CHARS) + '\n[... truncated to keep prompt size sane ...]';
  }

  const text = `${header}\n${body}\n=== END CURRENT HUD STATE ===`;
  const elapsed = Date.now() - startedAt;
  console.log(`[hud-ctx${compact ? ':compact' : ''}] built ${sections.length} sections, ${text.length} chars in ${elapsed}ms`);
  return text;
}

// ---------------------------------------------------------------------------
// Shared agent memory pool — pull top relevant lessons for the "jarvis" role
// so every conversation turn benefits from prior learnings (Heath spec
// 2026-06-22). 60s in-process cache keyed by (tenant + msg-prefix) to keep
// embed cost low (~$0.02 / 1M tokens but still — no need to embed every turn).
// Failure is non-fatal — we return '' and the prompt proceeds without it.
// ---------------------------------------------------------------------------
const _roleMemoryCache = new Map();
const ROLE_MEM_TTL_MS = 60 * 1000;

async function getJarvisRoleMemoryBlock(tenant, message) {
  if (!tenant || !tenant.id) return '';
  const key = `${tenant.id}|${String(message || '').slice(0, 200)}`;
  const hit = _roleMemoryCache.get(key);
  if (hit && (Date.now() - hit.at) < ROLE_MEM_TTL_MS) return hit.text;

  let lessons = [];
  // Try semantic search first
  try {
    if (OPENAI_API_KEY) {
      const embedding = await memoryEmbedText(String(message || '').slice(0, 1000));
      lessons = await memorySearch(tenant.id, 'jarvis', embedding, {
        matchThreshold: 0.40, matchCount: 6,
      });
    }
  } catch (err) {
    console.warn(`[jarvis-voice/role-memory] embed non-fatal: ${err.message}`);
  }
  // Fallback: pull top-by-usage+recency from the same role pool. Heath spec
  // 2026-06-22 — graceful degradation when OpenAI is throttled.
  if (!lessons || lessons.length === 0) {
    try {
      lessons = await sbGet(
        `agent_role_memory?select=id,title,content,category,validation_status,usage_count,tags,learned_at` +
        `&tenant_id=eq.${tenant.id}&agent_role=eq.jarvis&validation_status=neq.archived` +
        `&order=usage_count.desc,learned_at.desc&limit=6`
      );
    } catch (err) {
      console.warn(`[jarvis-voice/role-memory] fallback non-fatal: ${err.message}`);
      lessons = [];
    }
  }
  const text = memoryFormatBlock('jarvis', lessons || []);
  _roleMemoryCache.set(key, { at: Date.now(), text });
  return text;
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

  const {
    conversation_id, message, system_prompt_extension, approve_tool, client_context,
    // Vision payload (Build A 2026-06-25). image_base64 is the raw base64 string
    // (no "data:" prefix). image_media_type is one of image/jpeg | image/png |
    // image/gif | image/webp. PWA caps inbound at 1024px to control cost.
    image_base64, image_media_type,
  } = body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ ok: false, error: 'message is required' });
  }
  const hasImage = !!(image_base64 && typeof image_base64 === 'string');
  const imageMime = sanitizeImageMediaType(image_media_type);
  if (hasImage && !imageMime) {
    return res.status(400).json({ ok: false, error: 'image_media_type must be image/jpeg|png|gif|webp' });
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

  // Load last 30 messages from this conversation for history.
  // CRITICAL: order DESC + reverse in JS to get the MOST RECENT 30 messages
  // (not the oldest 30). Before this fix, long conversations (>30 turns)
  // were sending Claude the first 30 messages — every reply was based on
  // ancient context. Heath called it out: "Jarvis is a conversational idiot.
  // He asks a question, I say yes, then he says 'whenever you're ready'."
  const historyDesc = await sbGet(
    `jarvis_messages?select=role,content,created_at&conversation_id=eq.${convId}&order=created_at.desc&limit=30`
  );
  const history = (historyDesc || []).slice().reverse();

  // Persist the user message. For vision turns, append a marker so the DB row
  // reflects that an image was sent (we don't store the base64 in DB — it's
  // huge and only useful for the live turn). Build A 2026-06-25.
  const persistedUserContent = hasImage
    ? `${message.slice(0, 4000)} [image: ${imageMime}]`
    : message.slice(0, 4000);
  await sbPost('jarvis_messages', {
    conversation_id: convId,
    tenant_id: tenant.id,
    role: 'user',
    content: persistedUserContent,
  }, { prefer: 'return=minimal' });

  // Build system prompt with Anthropic prompt caching.
  //
  // PERF FIX 2026-06-25 (Atlas urgent): pre-cache change, every voice turn was
  // shipping 9k-29k input tokens (system prompt + client backbone) on every
  // call. Sonnet at 29k uncached ≈ 6-10s. Result: voice round-trip 8-12s.
  // Fix: split system into a structured blocks array with cache_control on
  // the stable portions. Anthropic returns ~85% input-token discount on cache
  // hits and dramatically lower latency.
  //
  // Cache layout (Anthropic caches blocks that come BEFORE the marker):
  //   [persona]                                            <- stable across all turns
  //   [PWA UI CAPABILITIES]                                <- static
  //   [role memory block]                                  <- 60s cache locally
  //   [client-provided extension]            cache_control <- caches everything above
  //   [LIVE TEMPORAL CONTEXT — rebuilt per turn]           <- NOT cached (date drift)
  //   [LIVE STATE — agents + todo + MRR]                   <- NOT cached (state churn)
  //
  // The "stable" prefix dominates token count (Heath's backbone is ~20k of
  // 25k total), so cache hit drops sub-second on every follow-up turn within
  // the 5-minute cache TTL.
  // Live context (3 sources in parallel to keep handleChat fast):
  //   - getContextExtension: MRR + todo + recent agent activity (cached 60s)
  //   - buildLiveTemporalBlock: date/time/timezone/location (always fresh)
  //   - buildHudStateContext: future builds + agent status + queue + knowledge
  //     + recent ships + open todo + completions (always fresh, ~1-2k tokens)
  //   - getJarvisRoleMemoryBlock: top relevant lessons from jarvis memory pool
  const [liveCtx, hudCtx, roleMemoryBlock] = await Promise.all([
    getContextExtension(tenant),
    buildHudStateContext(tenant),
    getJarvisRoleMemoryBlock(tenant, message),
  ]);
  const temporalCtx = buildLiveTemporalBlock(tenant, client_context);

  const stableParts = [buildSystemPrompt(tenant), PWA_UI_CAPABILITIES];
  if (roleMemoryBlock) stableParts.push(roleMemoryBlock);
  if (system_prompt_extension && typeof system_prompt_extension === 'string') {
    stableParts.push(system_prompt_extension.slice(0, 100000));
  }
  const stableText = stableParts.join('\n\n');

  // Dynamic suffix: HUD state goes FIRST (so it's the most prominent live
  // info) followed by temporal + live state. None of this is cached so it
  // refreshes every turn.
  const dynamicParts = [];
  if (hudCtx) dynamicParts.push(hudCtx);
  dynamicParts.push(temporalCtx);
  if (liveCtx) dynamicParts.push(liveCtx);
  const dynamicText = dynamicParts.join('\n\n');

  // Structured system: cached prefix + uncached suffix.
  const systemBlocks = [
    { type: 'text', text: stableText, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamicText },
  ];

  // Load enabled tools for this tenant
  const enabledToolNames = await fetchEnabledToolNames(tenant.id);
  const toolSpecs = buildToolSpecs(enabledToolNames);

  console.log(`[jarvis-voice/chat] [${requestId}] tenant=${tenant.slug} msg="${message.slice(0, 80)}" tools=${enabledToolNames.length}`);

  // Build messages array. Start with prior history + the new user message.
  // Anthropic requires turns to alternate user/assistant starting with user.
  // If the trimmed-to-30 history happens to start with an assistant turn
  // (because the oldest of the 30 is an assistant reply), drop it so the
  // sequence is well-formed.
  const cleanedHistory = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 4000) }));
  while (cleanedHistory.length && cleanedHistory[0].role !== 'user') {
    cleanedHistory.shift();
  }
  // For vision turns, the final user message must be a content-block array.
  // Order per Anthropic guidance: image first, then text. Build A 2026-06-25.
  const finalUserContent = hasImage
    ? [
        { type: 'image', source: { type: 'base64', media_type: imageMime, data: image_base64 } },
        { type: 'text', text: message.slice(0, 4000) },
      ]
    : message.slice(0, 4000);
  let messages = [
    ...cleanedHistory,
    { role: 'user', content: finalUserContent },
  ];

  // ===== Tool-use loop =====
  // Iterate up to MAX_TOOL_ITERATIONS times: send to Claude, if Claude
  // requests a tool, dispatch it, append the result, and loop again.
  const MAX_TOOL_ITERATIONS = 4;
  const toolAudit = [];
  let finalText = '';
  let usageIn = 0, usageOut = 0;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    let claudeRes;
    try {
      const reqBody = {
        // 2026-06-27: max_tokens raised 800 -> 4096 so long replies (e.g.
        // "read this entire memo back to me") aren't truncated mid-sentence.
        // Sonnet 4.6 supports up to 8192 output tokens.
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        system: systemBlocks,
        messages,
      };
      if (toolSpecs.length) reqBody.tools = toolSpecs;

      claudeRes = await withTimeout(
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify(reqBody),
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
    if (data.usage) {
      usageIn += data.usage.input_tokens || 0;
      usageOut += data.usage.output_tokens || 0;
    }
    const blocks = Array.isArray(data.content) ? data.content : [];

    // Collect text and tool_use blocks separately
    const textBlocks = blocks.filter((b) => b && b.type === 'text');
    const toolUseBlocks = blocks.filter((b) => b && b.type === 'tool_use');

    const iterText = textBlocks.map((b) => b.text || '').join('').trim();

    if (data.stop_reason === 'tool_use' && toolUseBlocks.length) {
      // Append Claude's turn (assistant role) carrying the tool_use blocks back
      messages.push({ role: 'assistant', content: blocks });

      // Dispatch each tool_use block and append tool_result blocks
      const toolResults = [];
      for (const tu of toolUseBlocks) {
        console.log(`[jarvis-voice/chat] [${requestId}] tool_use ${tu.name} id=${tu.id}`);
        const ctx = {
          tenant,
          jarvisUser,
          conversationId: convId,
          requestId,
          approved: approve_tool === tu.name,
        };
        const out = await dispatchTool(tu.name, tu.input || {}, ctx);
        toolAudit.push({ name: tu.name, ...out.audit });

        const resultPayload = out.error
          ? `ERROR: ${out.error}`
          : JSON.stringify(out.result || {}, null, 2).slice(0, 6000);

        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: resultPayload,
          is_error: !!out.error,
        });
      }
      messages.push({ role: 'user', content: toolResults });
      // Loop again — Claude will now formulate a reply using tool results
      continue;
    }

    // No tool_use — final reply
    finalText = iterText;
    break;
  }

  if (!finalText) {
    finalText = "Sorry sir, I came up empty on that one.";
  }

  // Persist the assistant message
  const assistantRow = await sbPost('jarvis_messages', {
    conversation_id: convId,
    tenant_id: tenant.id,
    role: 'assistant',
    content: finalText,
    tokens_in: usageIn || null,
    tokens_out: usageOut || null,
    tool_call: toolAudit.length ? { audit: toolAudit } : null,
  });

  // Best-effort log each tool invocation against the assistant message
  if (toolAudit.length) {
    const assistantMessageId = assistantRow[0].id;
    for (const a of toolAudit) {
      logToolInvocation({
        tenant,
        jarvisUser,
        conversationId: convId,
        assistantMessageId,
      }, a.name, null, null, a).catch(() => {});
    }
  }

  return res.status(200).json({
    ok: true,
    conversation_id: convId,
    message_id: assistantRow[0].id,
    response: finalText,
    tool_calls: toolAudit,
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
  const {
    conversation_id, message, system_prompt_extension, client_context,
    image_base64, image_media_type,
  } = body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ ok: false, error: 'message is required' });
  }
  const hasImage = !!(image_base64 && typeof image_base64 === 'string');
  const imageMime = sanitizeImageMediaType(image_media_type);
  if (hasImage && !imageMime) {
    return res.status(400).json({ ok: false, error: 'image_media_type must be image/jpeg|png|gif|webp' });
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

  // Atlas 2026-06-27 Lever B: detect short simple voice queries and serve
  // a compact HUD context. Cuts ~2k input tokens, ~150-300ms Anthropic TTFT.
  // Heuristic: short utterance (<= 10 words, <= 80 chars), no tool/intent
  // keywords, no image. Examples that get compact: "what's MRR?", "are you
  // there?", "what's the time?". Examples that stay full: "spawn atlas",
  // "what's on the future builds panel", "did anything ship today".
  const HUD_FULL_INTENT_RE = /\b(future\s*build|panel|agent|atlas|carter|hadley|pierce|sage|quinn|ridge|spawn|ship|merge|deploy|customer|brittney|miki|founder|founding|stripe|webhook|cron|todo|priority|deadline|legal|privacy|tos|terms|memory|context|search|query|email|telegram|sms|approve|reject|snooze|workflow|template|trec|docuseal|signing|bundle|vercel)\b/i;
  const wordCount = message.trim().split(/\s+/).length;
  const isCompactCandidate = wordCount <= 10
    && message.length <= 80
    && !hasImage
    && !HUD_FULL_INTENT_RE.test(message);
  if (isCompactCandidate) {
    console.log(`[jarvis-voice/chat_tts_stream] [${requestId}] compact-hud (msg="${message.slice(0, 60)}" words=${wordCount})`);
  }

  // Load history + persist user message + load live ctx in parallel.
  // CRITICAL: order DESC + reverse to get the MOST RECENT 30 (not oldest).
  // See handleChat() for the same fix and the bug it addresses.
  const [historyDesc, liveCtx, hudCtx] = await Promise.all([
    sbGet(`jarvis_messages?select=role,content,created_at&conversation_id=eq.${convId}&order=created_at.desc&limit=30`),
    sbPost('jarvis_messages', {
      conversation_id: convId,
      tenant_id: tenant.id,
      role: 'user',
      content: hasImage
        ? `${message.slice(0, 4000)} [image: ${imageMime}]`
        : message.slice(0, 4000),
    }, { prefer: 'return=minimal' }).then(() => getContextExtension(tenant)),
    buildHudStateContext(tenant, { compact: isCompactCandidate }),
  ]);
  // Dedupe: the parallel INSERT may have completed before the SELECT, so
  // the current user message could already be at the head of historyDesc
  // (DESC order = newest first). Strip only that first entry if it matches,
  // because Claude API rejects consecutive same-role turns.
  const trimmedMsg = message.slice(0, 4000);
  const persistedMsg = hasImage ? `${trimmedMsg} [image: ${imageMime}]` : trimmedMsg;
  let historyDescSafe = historyDesc || [];
  if (historyDescSafe.length && historyDescSafe[0].role === 'user' &&
      String(historyDescSafe[0].content || '').slice(0, 4000) === persistedMsg.slice(0, 4000)) {
    historyDescSafe = historyDescSafe.slice(1);
  }
  const history = historyDescSafe.slice().reverse();

  // Anthropic requires turns to start with user. Drop leading assistant turns
  // if the trimmed window happens to begin with one.
  const cleanedHistory = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 4000) }));
  while (cleanedHistory.length && cleanedHistory[0].role !== 'user') {
    cleanedHistory.shift();
  }

  // Vision turn → content-block array (image first, then text). Build A 2026-06-25.
  const finalUserContent = hasImage
    ? [
        { type: 'image', source: { type: 'base64', media_type: imageMime, data: image_base64 } },
        { type: 'text', text: trimmedMsg },
      ]
    : trimmedMsg;
  const finalMessages = [
    ...cleanedHistory,
    { role: 'user', content: finalUserContent },
  ];

  // Anthropic prompt caching — see handleChat() for the rationale + layout.
  // Same split: stable prefix (persona + UI caps + client extension) gets
  // cache_control; temporal + live state stay uncached so they refresh
  // every turn.
  const temporalCtx = buildLiveTemporalBlock(tenant, client_context);

  const stableParts = [buildSystemPrompt(tenant), PWA_UI_CAPABILITIES];
  if (system_prompt_extension && typeof system_prompt_extension === 'string') {
    stableParts.push(system_prompt_extension.slice(0, 100000));
  }
  const stableText = stableParts.join('\n\n');

  // Dynamic suffix: HUD state first (most prominent), then temporal, then
  // live state. None cached so it refreshes every voice turn.
  const dynamicParts = [];
  if (hudCtx) dynamicParts.push(hudCtx);
  dynamicParts.push(temporalCtx);
  if (liveCtx) dynamicParts.push(liveCtx);
  const dynamicText = dynamicParts.join('\n\n');

  const systemBlocks = [
    { type: 'text', text: stableText, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamicText },
  ];
  const voiceId = tenant?.voice_id || GEORGE_VOICE_ID;
  const settings = tenant?.voice_settings || GEORGE_SETTINGS;
  const modelId = settings.model || GEORGE_MODEL;

  console.log(`[jarvis-voice/chat_tts_stream] [${requestId}] conv=${convId} tenant=${tenant.slug} msg="${message.slice(0, 80)}" hud=${isCompactCandidate ? 'compact' : 'full'}`);

  // Atlas 2026-06-27 latency timing: stamps to measure Anthropic TTFT
  // and time to first audio chunk. Logged on every voice turn.
  const turnT0 = Date.now();
  let claudeRequestStartedAt = 0;
  let claudeFirstTokenAt = 0;
  let firstAudioSentAt = 0;

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
  claudeRequestStartedAt = Date.now();
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
          // 2026-06-27: max_tokens raised 500 -> 4096 so streaming replies
          // aren't cut off mid-thought. The sentence-chunked TTS pipeline
          // already handles arbitrary length — each sentence gets its own
          // ElevenLabs call.
          model: 'claude-sonnet-5',
          max_tokens: 4096,
          stream: true,
          system: systemBlocks,
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
        if (!firstAudioSentAt) firstAudioSentAt = Date.now();
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
            if (!claudeFirstTokenAt) claudeFirstTokenAt = Date.now();
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
  // Atlas 2026-06-27 latency log: server-side timing per voice turn.
  // turn_total = end-to-end SSE handler time
  // claude_ttft = ms from Claude request start → first token
  // first_audio = ms from turn start → first audio chunk written
  // After Lever B (compact HUD), expect ~20-40% reduction on first_audio
  // for short queries vs full-HUD baseline.
  const turnTotal = Date.now() - turnT0;
  const claudeTtft = claudeFirstTokenAt && claudeRequestStartedAt
    ? claudeFirstTokenAt - claudeRequestStartedAt : null;
  const firstAudioMs = firstAudioSentAt ? firstAudioSentAt - turnT0 : null;
  console.log(`[jarvis-voice/chat_tts_stream] [${requestId}] done conv=${convId} sentences=${sentenceSeq} chars=${fullText.length} hud=${isCompactCandidate ? 'compact' : 'full'} turn_total_ms=${turnTotal} claude_ttft_ms=${claudeTtft || '?'} first_audio_ms=${firstAudioMs || '?'}`);
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
            model: 'claude-sonnet-5',
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
        // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
        const titleText = ((dat?.content || [])
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('')
          .trim());
        title = titleText.slice(0, 80) || null;
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
        return await handleSTT(req, res, requestId, authUser);
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
