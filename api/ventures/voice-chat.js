/**
 * /api/ventures/voice-chat
 *
 * GET  ?agent=cole&limit=30  — load last N conversation turns from DB
 * POST { agent_name, message, history[] } — Claude reply + ElevenLabs TTS
 *
 * Auth: Bearer JWT via Supabase — heath emails only.
 * Env: ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * ============================================================
 * SQL — RUN IN SUPABASE SQL EDITOR BEFORE USING THIS ENDPOINT
 * ============================================================
 *
 * CREATE TABLE IF NOT EXISTS ventures_conversations (
 *   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *   agent_name TEXT NOT NULL,
 *   role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
 *   content TEXT NOT NULL,
 *   created_at TIMESTAMPTZ DEFAULT NOW()
 * );
 * CREATE INDEX IF NOT EXISTS idx_vc_agent ON ventures_conversations(agent_name, created_at DESC);
 *
 * -- RLS: allow service role only (no direct client access needed)
 * ALTER TABLE ventures_conversations ENABLE ROW LEVEL SECURITY;
 * CREATE POLICY "service_role_all" ON ventures_conversations
 *   FOR ALL USING (auth.role() = 'service_role');
 *
 * ============================================================
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const { generateSpeech } = require('../_utils/tts');

const AUTHORIZED_EMAILS = new Set([
  'heath.shepard@kw.com',
  'heath@meetdossie.com',
  'heath.shepard@gmail.com',
  'heathshepard@meetdossie.com',
]);

const VALID_AGENTS = new Set(['cole', 'hadley', 'pierce', 'carter', 'sage', 'atlas']);

const AGENT_CONFIG = {
  cole: {
    name: 'Cole',
    role: 'Chief of Staff',
    voice_id: 'pNInz6obpgDQGcFmaJgB', // Adam
    personality: 'You are Cole, Chief of Staff at Shepard Ventures. You are strategic, calm, and decisive. You coordinate all agents and keep Heath informed. You give clear next-action recommendations and never waste words.',
  },
  hadley: {
    name: 'Hadley',
    role: 'General Counsel',
    voice_id: '21m00Tcm4TlvDq8ikWAM', // Rachel
    personality: 'You are Hadley, General Counsel at Shepard Ventures. You are precise, careful, and carry warm authority. You handle legal strategy, compliance, entity formation, contracts, and risk management. You speak plainly with no unnecessary legalese.',
  },
  pierce: {
    name: 'Pierce',
    role: 'Growth & CS',
    voice_id: 'MF3mGyEYCl7XYWbV9V6O', // Elli
    personality: 'You are Pierce, Head of Growth and Customer Success at Shepard Ventures. You are energetic, direct, and conversion-focused. You own funnel optimization, lifecycle marketing, onboarding, activation, and retention for Dossie.',
  },
  carter: {
    name: 'Carter',
    role: 'Product Engineering',
    voice_id: 'ErXwobaYiN019PkySvjV', // Antoni
    personality: 'You are Carter, Head of Product Engineering at Shepard Ventures. You are methodical, confident, and a builder at heart. You own all Dossie feature builds, API routes, deployments, and the React frontend. You always stage before prod.',
  },
  sage: {
    name: 'Sage',
    role: 'Social Media',
    voice_id: 'lxYfHSkYm1EzQzGhdbfc', // Luna
    personality: 'You are Sage, Head of Social Media at Shepard Ventures. You are creative, platform-native, and sharp. You own strategy, content optimization, posting schedules, and algorithm performance for Dossie across all platforms.',
  },
  atlas: {
    name: 'Atlas',
    role: 'Platform Engineering',
    voice_id: 'pqHfZKP75CvOlQylNhV4', // Bill
    personality: 'You are Atlas, Head of Platform Engineering at Shepard Ventures. You are deep, reliable, and infrastructure-minded. You build the rails everything else runs on. You are opinionated, security-aware, and allergic to over-engineering.',
  },
};

const SYSTEM_PROMPT_TEMPLATE = (cfg) =>
  `${cfg.personality} Heath Shepard is the founder — he is building Dossie (a Texas real estate SaaS with 12 founding members at $29/mo, $320 MRR) and the Paralegal SaaS venture. This is a spoken voice conversation so keep replies concise: 2-4 sentences maximum, no lists, no markdown, no bullet points. Be direct and speak naturally.`;

// CORS helper
const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;
const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function corsHeaders(req) {
  const origin = req.headers['origin'] || '';
  const allowed = ALLOWED_ORIGINS.has(origin) || PREVIEW_RE.test(origin) || LOCAL_RE.test(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : '',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
  };
}

function applyCors(req, res) {
  const h = corsHeaders(req);
  Object.entries(h).forEach(([k, v]) => res.setHeader(k, v));
}

// Supabase REST helper
function supa(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
}

async function verifyAuth(req) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return AUTHORIZED_EMAILS.has(u.email) ? u : null;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // ─── GET: load conversation history ───────────────────────────────────
  if (req.method === 'GET') {
    const agent = req.query.agent || '';
    const limit = Math.min(Number(req.query.limit) || 30, 100);

    if (!VALID_AGENTS.has(agent)) {
      return res.status(400).json({ error: `Invalid agent: ${agent}` });
    }

    const qs = [
      `select=id,agent_name,role,content,created_at`,
      `agent_name=eq.${encodeURIComponent(agent)}`,
      `limit=${limit}`,
      `order=created_at.desc`,
    ].join('&');

    const r = await supa(`ventures_conversations?${qs}`);
    if (!r.ok) {
      const err = await r.text();
      console.error('[voice-chat GET] supabase error', err);
      return res.status(500).json({ error: 'Failed to load history' });
    }
    const rows = await r.json();
    // Reverse to get chronological order (DB query was desc for LIMIT efficiency)
    const turns = [...rows].reverse();
    return res.status(200).json({ turns });
  }

  // ─── POST: send message, get reply + audio ─────────────────────────────
  if (req.method === 'POST') {
    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const { agent_name, message, history = [] } = body || {};

    if (!agent_name || !VALID_AGENTS.has(agent_name)) {
      return res.status(400).json({ error: `Invalid agent_name: ${agent_name}` });
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    const cfg = AGENT_CONFIG[agent_name];

    // Fetch last 20 turns from DB for this agent (chronological)
    const histQs = [
      `select=role,content`,
      `agent_name=eq.${encodeURIComponent(agent_name)}`,
      `limit=20`,
      `order=created_at.desc`,
    ].join('&');
    let dbHistory = [];
    try {
      const hr = await supa(`ventures_conversations?${histQs}`);
      if (hr.ok) {
        const rows = await hr.json();
        dbHistory = [...rows].reverse(); // chronological
      }
    } catch (e) {
      console.warn('[voice-chat POST] DB history fetch failed:', e.message);
    }

    // Build Claude messages: DB history takes precedence, then incoming history[] for fallback,
    // then the new user message. If DB history is populated use it; otherwise use passed history.
    const baseHistory = dbHistory.length > 0
      ? dbHistory
      : (Array.isArray(history) ? history.slice(-10) : []);

    // Sanitize
    const claudeMessages = [
      ...baseHistory
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: String(m.content || '').slice(0, 4000) })),
      { role: 'user', content: message.trim().slice(0, 4000) },
    ];

    // ── Call Claude (non-streaming, max 300 tokens for voice-friendly responses) ──
    let replyText = '';
    try {
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          system: SYSTEM_PROMPT_TEMPLATE(cfg),
          messages: claudeMessages,
          stream: false,
        }),
      });

      if (!claudeRes.ok) {
        const errText = await claudeRes.text();
        console.error('[voice-chat POST] Anthropic error:', errText);
        return res.status(502).json({ error: 'Claude API error', detail: errText });
      }

      const claudeData = await claudeRes.json();
      // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
      replyText = ((claudeData?.content || [])
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
        .trim());
    } catch (e) {
      console.error('[voice-chat POST] Claude call failed:', e.message);
      return res.status(502).json({ error: 'Claude call failed', detail: e.message });
    }

    if (!replyText) {
      return res.status(502).json({ error: 'Empty reply from Claude' });
    }

    // ── Persist both turns to DB ──
    const now = new Date();
    const msOffset = 1; // ensure ordering
    const userRow = {
      agent_name,
      role: 'user',
      content: message.trim().slice(0, 10000),
      created_at: new Date(now.getTime()).toISOString(),
    };
    const assistantRow = {
      agent_name,
      role: 'assistant',
      content: replyText.slice(0, 10000),
      created_at: new Date(now.getTime() + msOffset).toISOString(),
    };

    try {
      await supa('ventures_conversations', {
        method: 'POST',
        body: JSON.stringify([userRow, assistantRow]),
      });
    } catch (e) {
      // Non-fatal — don't block the response if DB write fails
      console.warn('[voice-chat POST] DB persist failed:', e.message);
    }

    // ── TTS (ElevenLabs with OpenAI fallback) ──
    let audioBase64 = null;
    try {
      const { buffer, provider } = await generateSpeech(replyText, {
        elevenLabsVoiceId: cfg.voice_id,
        persona: agent_name,
        voiceSettings: { stability: 0.5, similarity_boost: 0.75 },
      });
      audioBase64 = buffer.toString('base64');
      console.log(`[voice-chat POST] TTS provider: ${provider}`);
    } catch (e) {
      console.warn('[voice-chat POST] TTS failed (no audio):', e.message);
      // Non-fatal: return text reply without audio
    }

    return res.status(200).json({
      reply_text: replyText,
      audio_base64: audioBase64,
      agent_name,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
