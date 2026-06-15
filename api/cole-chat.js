// Vercel Serverless Function: /api/cole-chat
// Browser-to-Cole brain: accepts a user message from orb-web.html, calls
// Claude Sonnet 4.6 with Cole's chief-of-staff persona, returns the reply.
//
// Body: { message: string, history?: [{role:'user'|'assistant', content:string}] }
// Response: { ok:true, response: string }  (non-streaming for orb v1)
//
// Env: ANTHROPIC_API_KEY
// Auth: none — public for the orb prototype. IP rate-limited (60/hr).
// Owner: Atlas (SV-VOICE-002 / Cole voice loop)

import {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} from './_middleware/rateLimit.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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

export const config = { maxDuration: 30 };

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!ANTHROPIC_API_KEY) {
    console.error('[cole-chat] ANTHROPIC_API_KEY not set');
    return res.status(503).json({
      ok: false,
      error: 'Chat not configured — ANTHROPIC_API_KEY missing',
    });
  }

  try {
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'cole-chat', 60, 60 * 60 * 1000);

    const { message, history } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ ok: false, error: 'message is required' });
    }

    // Sanitise history: only allow role/content, max 20 turns, 2000 chars each.
    const sanitizedHistory = Array.isArray(history)
      ? history
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
          .slice(-20)
          .map((m) => ({
            role: m.role,
            content: String(m.content || '').slice(0, 2000),
          }))
      : [];

    const finalMessages = [
      ...sanitizedHistory,
      { role: 'user', content: message.slice(0, 4000) },
    ];

    const requestId = `cch_${Date.now()}_${Math.random().toString(36).substr(2, 7)}`;
    console.log(`[cole-chat] [${requestId}] user msg: "${message.slice(0, 80)}"`);

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        // Sonnet 4.6 — fast and conversational. Heath confirmed in the brief.
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: COLE_SYSTEM_PROMPT,
        messages: finalMessages,
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text().catch(() => '');
      console.error(
        `[cole-chat] [${requestId}] Claude ${claudeRes.status}: ${errText.slice(0, 300)}`
      );
      return res.status(502).json({
        ok: false,
        error: 'Claude API error',
        status: claudeRes.status,
      });
    }

    const data = await claudeRes.json();
    const blocks = Array.isArray(data && data.content) ? data.content : [];
    const text = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim();

    if (!text) {
      console.warn(`[cole-chat] [${requestId}] empty response from Claude`);
      return res.status(502).json({ ok: false, error: 'Empty response' });
    }

    console.log(`[cole-chat] [${requestId}] reply "${text.slice(0, 80)}"`);
    return res.status(200).json({ ok: true, response: text });
  } catch (err) {
    if (err instanceof RateLimitError) {
      if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: 'Rate limit exceeded. Try again later.' });
    }
    console.error('[cole-chat] error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'Chat failed' });
  }
}
