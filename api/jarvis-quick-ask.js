// Vercel Serverless Function: /api/jarvis-quick-ask
// =========================================================================
// Routes a voice or text question to one of Heath's specialists and returns
// (a) the specialist's answer text, and (b) optionally a George-voice MP3 of
// that answer for the PWA to play back. Jarvis is the orchestrator; he
// speaks the specialist's answer to Heath in his own voice.
//
// POST /api/jarvis-quick-ask
//   Body:
//     {
//       specialist: "hadley" | "sterling" | "pierce",
//       question: string,
//       context?: object,                // forwarded to ask-hadley if applicable
//       speak?: boolean (default true)   // when true, return audio/mpeg
//     }
//
// Auth: REQUIRED Bearer Supabase JWT (forwarded to specialist endpoints).
//
// Returns:
//   - If speak=false: JSON { ok:true, specialist, question, answer, citations? }
//   - If speak=true:  audio/mpeg with headers X-Specialist, X-Answer-Text
//
// Owner: Atlas (Tier 2 build, 2026-06-21).

import { verifySupabaseToken } from './_middleware/auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

const JARVIS_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'; // George (Iron Man HUD locked)
const CLAUDE_MODEL = 'claude-sonnet-4-6';

const VALID_SPECIALISTS = new Set(['hadley', 'sterling', 'pierce']);

export const config = { api: { bodyParser: true }, maxDuration: 30 };

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// Persona prompts. ask-hadley already has its own knowledge-base-backed
// endpoint we delegate to; sterling + pierce don't have dedicated endpoints
// yet, so we synthesize their answers here via Claude with persona prompts.

const PERSONA_PROMPTS = {
  sterling: `You are Sterling, Heath Shepard's markets and portfolio strategy analyst at Shepard Ventures.

Voice: data-driven, plainspoken, honest about limits. You don't predict; you surface information.

Address Heath as "sir" naturally (not every sentence). Be concise — Heath listens to your answer verbally and reads slowly. Aim for 4-6 sentences max unless he explicitly asked for depth.

Topics you cover: stocks, crypto, ETFs, macro indicators, sector trends, earnings calendars, catalyst tracking, risk-managed position sizing, strategy backtesting concepts.

You will NOT execute trades. You analyze and recommend; Heath executes.

If the question is outside markets (legal, growth/CS, infra), tell Heath which specialist owns it and offer your own market-adjacent take if relevant.`,

  pierce: `You are Pierce, Heath Shepard's Head of Growth and Customer Success at Shepard Ventures (Dossie).

Voice: warm, founder-direct, action-oriented. You treat every customer like a friend Heath introduced you to.

Address Heath as "Heath" or "boss" — not "sir." Be concise — verbal answer, 4-6 sentences max.

Topics you cover: customer activation, founder outreach, funnel optimization, retention plays, churn recovery, weekly improvements communication, founding-member experience, lead handoffs from Sage.

If the question is legal (Hadley), markets (Sterling), or infrastructure (Atlas), name the right specialist and offer your growth-angle take.`,
};

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`sbGet ${path} -> ${r.status} ${body.slice(0, 200)}`);
  }
  return r.json();
}

async function logQuestion(tenantId, specialist, question, answer) {
  // Fire-and-forget audit trail.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/jarvis_agent_events`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        tenant_id: tenantId,
        agent_name: specialist,
        event_type: 'completed',
        status: 'completed',
        task_title: question.slice(0, 100),
        prompt: question,
        result_summary: (answer || '').slice(0, 500),
        summary: (answer || '').slice(0, 200),
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        details: { source: 'jarvis_quick_ask' },
      }),
    });
  } catch (err) {
    console.warn('[jarvis-quick-ask] log failed:', err.message);
  }
}

// Call the existing ask-hadley endpoint. We re-use Vercel internal routing
// by talking to the same deployment host.
async function callAskHadley(req, question, context) {
  const host = req.headers.host;
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const url = `${proto}://${host}/api/ask-hadley`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: req.headers.authorization || '',
    },
    body: JSON.stringify({ question, context: context || {} }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`ask-hadley ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function answerWithPersona(specialist, question) {
  if (!ANTHROPIC_API_KEY) {
    return { answer: `I'd dig in, but my Anthropic key isn't configured. Sorry, ${specialist === 'sterling' ? 'sir' : 'Heath'}.` };
  }
  const system = PERSONA_PROMPTS[specialist];
  const r = await Promise.race([
    fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 600,
        system,
        messages: [{ role: 'user', content: question }],
      }),
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('claude_timeout')), 18000)),
  ]);
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`claude ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  return { answer: (data.content?.[0]?.text || '').trim() };
}

async function renderGeorgeTTS(text) {
  if (!ELEVENLABS_API_KEY) throw new Error('elevenlabs_env_missing');
  // Prefix Jarvis framing so Heath hears George (Jarvis voice) summarize the
  // specialist's answer rather than a voice swap mid-PWA. This matches the
  // Jarvis-as-orchestrator UX in the spec.
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${JARVIS_VOICE_ID}?output_format=mp3_44100_192`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.50,
          style: 0.45,
          use_speaker_boost: true,
        },
      }),
    }
  );
  if (!r.ok) {
    const errTxt = await r.text().catch(() => '');
    throw new Error(`elevenlabs ${r.status}: ${errTxt.slice(0, 200)}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let authUser;
  try {
    authUser = await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: err.message });
  }

  const { specialist, question, context, speak = true } = req.body || {};
  if (!specialist || !VALID_SPECIALISTS.has(specialist)) {
    return res.status(400).json({ ok: false, error: 'invalid_specialist', valid: Array.from(VALID_SPECIALISTS) });
  }
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ ok: false, error: 'question_required' });
  }

  // Resolve tenant for the audit log.
  let tenantId = null;
  try {
    const rows = await sbGet(`jarvis_users?select=tenant_id&auth_user_id=eq.${authUser.userId}&limit=1`);
    if (rows && rows.length) tenantId = rows[0].tenant_id;
  } catch {}

  // Dispatch.
  let answer = '';
  let citations = [];
  try {
    if (specialist === 'hadley') {
      const r = await callAskHadley(req, question.trim(), context);
      if (!r.ok) {
        return res.status(502).json({ ok: false, error: 'hadley_failed', detail: r.error });
      }
      answer = r.answer || '';
      citations = Array.isArray(r.citations) ? r.citations : [];
    } else {
      const r = await answerWithPersona(specialist, question.trim());
      answer = r.answer || '';
    }
  } catch (err) {
    console.error('[jarvis-quick-ask] dispatch failed:', err.message);
    return res.status(502).json({ ok: false, error: 'specialist_failed', detail: err.message });
  }

  if (!answer) {
    return res.status(502).json({ ok: false, error: 'empty_answer' });
  }

  // Log (fire-and-forget).
  if (tenantId) logQuestion(tenantId, specialist, question.trim(), answer);

  if (!speak) {
    return res.status(200).json({
      ok: true,
      specialist,
      question: question.trim(),
      answer,
      citations,
    });
  }

  // Render audio in Jarvis's George voice.
  try {
    const buf = await renderGeorgeTTS(answer);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Specialist', specialist);
    res.setHeader('X-Answer-Text', encodeURIComponent(answer.slice(0, 2000)));
    if (citations.length) {
      res.setHeader('X-Citations', encodeURIComponent(JSON.stringify(citations).slice(0, 2000)));
    }
    return res.status(200).send(buf);
  } catch (err) {
    console.error('[jarvis-quick-ask] TTS failed:', err.message);
    return res.status(200).json({
      ok: true,
      specialist,
      question: question.trim(),
      answer,
      citations,
      tts_failed: true,
      tts_detail: err.message,
    });
  }
}
