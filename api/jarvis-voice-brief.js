// Vercel Serverless Function: /api/jarvis-voice-brief
// =========================================================================
// 60-second morning brief audio for the Jarvis PWA Voice Brief button.
//
// Pipeline:
//   1. Pull state in parallel from Supabase (todos, pending approvals,
//      MRR, customer activity, agent events, debrief).
//   2. Compose a ~150-word script via Claude Sonnet 4.6.
//   3. Render with ElevenLabs George (JBFqnCBsd6RMkjVDRZzb) MP3 192kbps.
//   4. Cache row in jarvis_voice_briefs for 12 hours (per-tenant + brief_date).
//   5. Return audio/mpeg (or JSON with text only if ?script=1).
//
// Cache strategy:
//   - "Brief date" is today's date in Heath's TZ (America/Chicago) UNLESS
//     the current time is before 8am, in which case we use yesterday's date.
//     (Matches the "morning brief" mental model: before sunrise the brief
//     for "today's morning" is still being prepped from yesterday's data.)
//   - We look up the freshest non-expired row for (tenant, brief_date);
//     if found, we serve its audio directly. If missing, regenerate.
//   - `?refresh=1` bypasses the cache.
//
// GET /api/jarvis-voice-brief
//   ?refresh=1   force regenerate
//   ?script=1    return JSON only (no audio render); useful for previews
//
// Auth: REQUIRED Bearer Supabase JWT.
//
// Owner: Atlas (Tier 2 build, 2026-06-21).

import { verifySupabaseToken } from './_middleware/auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

const JARVIS_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'; // George (Iron Man HUD locked spec)
const CLAUDE_MODEL = 'claude-sonnet-5';

export const config = { api: { bodyParser: true }, maxDuration: 30 };

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

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

async function sbPost(path, body, prefer = 'return=representation') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`sbPost ${path} -> ${r.status} ${txt.slice(0, 200)}`);
  }
  return prefer.includes('representation') ? r.json() : null;
}

async function resolveTenant(authUserId) {
  const rows = await sbGet(
    `jarvis_users?select=tenant_id,tenants(id,slug,display_name,addressing_pref)&auth_user_id=eq.${authUserId}&limit=1`
  );
  if (!rows || rows.length === 0) return null;
  return rows[0].tenants;
}

// "Brief date" = today's date in Heath's TZ, or yesterday if before 8am.
function getBriefDate() {
  const now = new Date();
  // Convert to America/Chicago wall-clock time.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const hour = parseInt(parts.hour, 10);
  let y = parseInt(parts.year, 10);
  let m = parseInt(parts.month, 10);
  let d = parseInt(parts.day, 10);
  if (hour < 8) {
    // Roll back one day.
    const prior = new Date(Date.UTC(y, m - 1, d) - 24 * 3600 * 1000);
    y = prior.getUTCFullYear();
    m = prior.getUTCMonth() + 1;
    d = prior.getUTCDate();
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

async function loadCachedBrief(tenantId, briefDate) {
  try {
    const rows = await sbGet(
      `jarvis_voice_briefs?select=id,script_text,audio_bytes,audio_mime,generated_at,expires_at`
      + `&tenant_id=eq.${tenantId}`
      + `&brief_date=eq.${briefDate}`
      + `&expires_at=gte.${new Date().toISOString()}`
      + `&order=generated_at.desc&limit=1`
    );
    return rows && rows.length ? rows[0] : null;
  } catch (err) {
    console.warn('[jarvis-voice-brief] cache lookup failed:', err.message);
    return null;
  }
}

async function gatherState(tenantId) {
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [todoRes, decRes, agentRes, mrrRes, custRes, activityRes, pendingRes] = await Promise.all([
    sbGet(`heath_todo?select=id,title,priority&status=eq.pending&order=priority.asc&limit=5`).catch(() => []),
    sbGet(`decision_queue?select=id,title&status=eq.pending&limit=10`).catch(() => []),
    sbGet(`jarvis_agent_events?select=agent_name,event_type,summary,created_at&tenant_id=eq.${tenantId}&order=created_at.desc&limit=8`).catch(() => []),
    sbGet(`subscriptions?select=id,status&status=eq.active`).catch(() => []),
    sbGet(`subscriptions?select=id,created_at&created_at=gte.${dayAgo}`).catch(() => []),
    sbGet(`profiles?select=id,full_name,last_seen_at&last_seen_at=gte.${dayAgo}&order=last_seen_at.desc&limit=5`).catch(() => []),
    sbGet(`heath_todo?select=id&status=eq.pending&priority=lte.2`).catch(() => []),
  ]);

  const todos = Array.isArray(todoRes) ? todoRes : [];
  const decisions = Array.isArray(decRes) ? decRes : [];
  const activeAgents = Array.isArray(agentRes)
    ? Array.from(new Set(agentRes.filter(e => e.event_type === 'spawned' || e.event_type === 'progress' || e.event_type === 'working' || e.event_type === 'heartbeat').map(e => e.agent_name)))
    : [];
  const mrr = (Array.isArray(mrrRes) ? mrrRes.length : 0) * 29; // founding tier
  const newSignups = Array.isArray(custRes) ? custRes.length : 0;
  const activeUsers = Array.isArray(activityRes) ? activityRes.length : 0;
  const urgent = Array.isArray(pendingRes) ? pendingRes.length : 0;

  return {
    top_todos: todos.slice(0, 3).map(t => t.title),
    decisions_pending: decisions.length,
    active_agents: activeAgents,
    mrr_usd: mrr,
    new_signups_24h: newSignups,
    active_users_24h: activeUsers,
    urgent_count: urgent,
    recent_agent_activity: Array.isArray(agentRes) ? agentRes.slice(0, 3).map(e => ({
      agent: e.agent_name,
      summary: (e.summary || '').slice(0, 100),
    })) : [],
  };
}

async function generateScript(state, addressing = 'sir') {
  if (!ANTHROPIC_API_KEY) {
    // Fallback: deterministic template if Anthropic key missing.
    return buildTemplateScript(state, addressing);
  }
  const system = `You are Jarvis, Heath Shepard's AI chief of staff. Voice: refined British male, calm, capable, dry humor occasionally. Address Heath as "${addressing}" naturally — not every sentence.

Write a 150-word morning brief that sounds like a real EA delivering a verbal update. Open with a greeting, cover MRR, top to-dos, agent activity, and one closing line. No corporate hedging. No "as your AI." Plain spoken. Sub-60 seconds when read aloud.`;

  const userMsg = `Compose today's morning brief based on this state:

MRR: $${state.mrr_usd}/month
New signups (24h): ${state.new_signups_24h}
Active users (24h): ${state.active_users_24h}
Urgent items pending: ${state.urgent_count}
Decisions waiting on Heath: ${state.decisions_pending}
Active agents right now: ${state.active_agents.length ? state.active_agents.join(', ') : 'none'}
Top to-dos:
${state.top_todos.length ? state.top_todos.map(t => `  - ${t}`).join('\n') : '  - (none pending)'}
Recent agent activity:
${state.recent_agent_activity.length ? state.recent_agent_activity.map(a => `  - ${a.agent}: ${a.summary}`).join('\n') : '  - (quiet)'}

Output the brief text only. No prefix, no markdown, no quotes. Plain text the TTS engine will read aloud.`;

  try {
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
          max_tokens: 400,
          system,
          messages: [{ role: 'user', content: userMsg }],
        }),
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('claude_timeout')), 12000)),
    ]);
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.warn('[jarvis-voice-brief] claude failed:', r.status, txt.slice(0, 200));
      return buildTemplateScript(state, addressing);
    }
    const data = await r.json();
    // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
    const text = ((data?.content || [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim());
    if (!text) return buildTemplateScript(state, addressing);
    return text;
  } catch (err) {
    console.warn('[jarvis-voice-brief] claude error:', err.message);
    return buildTemplateScript(state, addressing);
  }
}

function buildTemplateScript(state, addressing) {
  const parts = [];
  parts.push(`Good morning, ${addressing}.`);
  parts.push(`MRR is at ${formatCurrency(state.mrr_usd)} a month.`);
  if (state.new_signups_24h > 0) parts.push(`${state.new_signups_24h} new ${state.new_signups_24h === 1 ? 'signup' : 'signups'} in the last twenty-four hours.`);
  if (state.urgent_count > 0) parts.push(`${state.urgent_count} urgent ${state.urgent_count === 1 ? 'item' : 'items'} waiting on you.`);
  if (state.decisions_pending > 0) parts.push(`${state.decisions_pending} ${state.decisions_pending === 1 ? 'decision' : 'decisions'} need your call.`);
  if (state.active_agents.length) parts.push(`${state.active_agents.length} ${state.active_agents.length === 1 ? 'agent is' : 'agents are'} working: ${state.active_agents.join(', ')}.`);
  if (state.top_todos.length) parts.push(`Top of the list: ${state.top_todos[0]}.`);
  parts.push(`That's the picture, ${addressing}. I'll be here when you're ready.`);
  return parts.join(' ');
}

function formatCurrency(n) {
  return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

async function renderTTS(text) {
  if (!ELEVENLABS_API_KEY) throw new Error('elevenlabs_env_missing');
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

// PostgREST encodes bytea as hex with leading "\x" by default. We store as
// base64 by passing JSON value; PostgREST accepts base64 if the column is bytea
// when sent via Prefer: return=representation? Actually safest path: keep
// bytes in storage by encoding as base64 string in the script_text? No.
// Better: re-render on cache MISS, cache only the SCRIPT, not the audio.
// Audio buffer is small (~250KB for 60s mp3@192k) but bytea+PostgREST is
// fiddly. SIMPLIFICATION: cache the script for 12h, regenerate audio each
// time (≤2s on ElevenLabs Turbo). This keeps the DB simple and the audio
// fresh; the slow path is Claude, which we already cached.
//
// So audio_bytes is RESERVED for future use; for v1 we leave it null.

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  let authUser;
  try {
    authUser = await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: err.message });
  }

  let tenant;
  try {
    tenant = await resolveTenant(authUser.userId);
  } catch (err) {
    console.error('[jarvis-voice-brief] tenant resolve:', err.message);
    return res.status(500).json({ ok: false, error: 'tenant_lookup_failed' });
  }
  if (!tenant || !tenant.id) {
    return res.status(403).json({ ok: false, error: 'no_jarvis_tenant' });
  }

  const briefDate = getBriefDate();
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  const scriptOnly = req.query.script === '1' || req.query.script === 'true';

  // Try cache (script only).
  let scriptText = null;
  let cacheHit = false;
  if (!refresh) {
    const cached = await loadCachedBrief(tenant.id, briefDate);
    if (cached && cached.script_text) {
      scriptText = cached.script_text;
      cacheHit = true;
    }
  }

  if (!scriptText) {
    // Cache miss — gather + generate.
    try {
      const state = await gatherState(tenant.id);
      scriptText = await generateScript(state, tenant.addressing_pref || 'sir');
    } catch (err) {
      console.error('[jarvis-voice-brief] state gather/gen:', err.message);
      return res.status(500).json({ ok: false, error: 'brief_generation_failed' });
    }

    // Persist (fire-and-forget on best effort).
    try {
      await sbPost('jarvis_voice_briefs', {
        tenant_id: tenant.id,
        brief_date: briefDate,
        script_text: scriptText,
        voice_id: JARVIS_VOICE_ID,
        metadata: { source: 'jarvis-voice-brief', refresh },
      });
    } catch (err) {
      console.warn('[jarvis-voice-brief] cache persist failed:', err.message);
    }
  }

  if (scriptOnly) {
    return res.status(200).json({
      ok: true,
      brief_date: briefDate,
      cached: cacheHit,
      text: scriptText,
    });
  }

  // Render audio.
  let buf;
  try {
    buf = await renderTTS(scriptText);
  } catch (err) {
    console.error('[jarvis-voice-brief] TTS failed:', err.message);
    return res.status(502).json({ ok: false, error: 'tts_failed', detail: err.message, text: scriptText });
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Brief-Date', briefDate);
  res.setHeader('X-Brief-Cached', cacheHit ? '1' : '0');
  res.setHeader('X-Brief-Text', encodeURIComponent(scriptText.slice(0, 2000)));
  return res.status(200).send(buf);
}
