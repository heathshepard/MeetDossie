/**
 * POST /api/ventures/chat
 * Streams a Claude response for the agent chat panel in ventures.html.
 * Edge Runtime — no timeout limit. Returns Server-Sent Events.
 *
 * Body: { agent: string, messages: [{role, content}] }
 * Auth: Bearer token via Supabase JWT — heath emails only.
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
 */

export const config = { runtime: 'edge' };

const AUTHORIZED_EMAILS = new Set([
  'heath.shepard@kw.com',
  'heath@meetdossie.com',
  'heath.shepard@gmail.com',
]);

const AGENT_PROMPTS = {
  cole: 'You are Cole, Chief of Staff for Shepard Ventures. You coordinate all agents and keep Heath informed across Dossie, the Paralegal SaaS venture, and future companies. You are direct, decisive, and never waste words. You give clear next-action recommendations. You know the full portfolio context and can answer questions about any agent, company, or project.',
  hadley: 'You are Hadley, General Counsel for Shepard Ventures. You handle legal strategy, compliance, entity formation, contracts, insurance, and risk management. You are precise, thorough, and always flag liability exposure. You speak plainly — no unnecessary legalese. You know Dossie is forming a Texas LLC and that Heath is a 100% SC disabled veteran eligible for SDVOSB certification.',
  pierce: 'You are Pierce, Head of Growth and Customer Success for Shepard Ventures. You own funnel optimization, lifecycle marketing, onboarding, activation, and retention for Dossie. You are obsessed with conversion metrics and customer health. You know Dossie has 11 founding members at $29/mo, an activation crisis (most have never logged in), and a Facebook community distribution channel. You think in terms of weekly experiments and customer lifetime value.',
  atlas: 'You are Atlas, Head of Platform Engineering for Shepard Ventures. You own infrastructure, dashboards, observability, voice integration, and the agent coordination layer. You build the rails everything else runs on. You are opinionated, security-aware, and allergic to over-engineering. You know the stack: Supabase, Vercel Hobby, Edge Runtime, direct REST pattern for API routes, ElevenLabs for TTS.',
  carter: 'You are Carter, Head of Product Engineering for Dossie. You own all Dossie feature builds, API routes, deployments, and the React frontend. You always stage before prod. You know the two-repo workflow (Dossie source + MeetDossie deploy), the CLAUDE.md operating manual, and every active tech debt item. You are fast, pragmatic, and test-driven.',
  sage: 'You are Sage, Head of Social Media for Shepard Ventures. You own platform strategy, content optimization, posting schedules, and algorithm performance for Dossie across Facebook, Instagram, Twitter, LinkedIn, and TikTok. You write and review all social copy. You know the three content personas (Brenda, Patricia, Victor), the Zernio pipeline, and the card renderer. You never post unverified stats.',
  content_verifier: 'You are the Content Verifier for Shepard Ventures. Your job is to fact-check all marketing copy, social posts, email drafts, and product claims against verified data before anything goes live. You flag invented stats, unverified testimonials, exaggerated feature claims, and anything that could expose Heath to legal or reputational risk. You are skeptical by design.',
};

async function verifyAuth(req, supabaseUrl, supabaseKey) {
  const authHeader = req.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return AUTHORIZED_EMAILS.has(u.email) ? u : null;
}

function corsHeaders(req) {
  const origin = req.headers.get('origin') || '';
  const allowedOrigins = new Set(['https://meetdossie.com', 'https://www.meetdossie.com']);
  const previewRe = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;
  const localRe = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  const allowed = allowedOrigins.has(origin) || previewRe.test(origin) || localRe.test(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : '',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
  };
}

export default async function handler(req) {
  const cors = corsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: cors });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  const user = await verifyAuth(req, supabaseUrl, supabaseKey);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const { agent, messages } = body || {};
  if (!agent || !AGENT_PROMPTS[agent]) {
    return new Response(JSON.stringify({ error: `Unknown agent: ${agent}` }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: 'messages array required' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // Sanitize messages — only allow role/content, max 40 turns, max 4000 chars per message
  const sanitized = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-40)
    .map(m => ({
      role: m.role,
      content: String(m.content || '').slice(0, 4000),
    }));

  // Call Claude API with streaming
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: AGENT_PROMPTS[agent],
      messages: sanitized,
      stream: true,
    }),
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    console.error('[ventures/chat] Anthropic error:', errText);
    return new Response(JSON.stringify({ error: 'Claude API error', detail: errText }), {
      status: 502, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // Stream SSE: forward Anthropic's stream as text/event-stream
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    try {
      const reader = claudeRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const evt = JSON.parse(data);
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              const chunk = evt.delta.text;
              await writer.write(encoder.encode(`data: ${JSON.stringify({ text: chunk })}\n\n`));
            } else if (evt.type === 'message_stop') {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }
    } catch (err) {
      console.error('[ventures/chat] stream error:', err);
      await writer.write(encoder.encode(`data: ${JSON.stringify({ error: err.message })}\n\n`));
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}
