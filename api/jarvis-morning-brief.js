// Jarvis V5 R5 — Wake Jarvis morning brief.
// Returns: spoken text (and optionally an mp3 stream via ElevenLabs George).
// Heath-only.
//
// GET ?speak=1 → returns audio/mpeg from ElevenLabs George (rich, deep British male — refined AI butler)
// GET ?speak=0 (default) → returns JSON with text + counts
//
// V5 R7 (2026-06-18): swapped Bill → Daniel.
// V5 R8 (2026-06-19): swapped Daniel → George per Heath. George = JBFqnCBsd6RMkjVDRZzb.
//   Closer to original Iron Man Jarvis (Paul Bettany) — richer, deeper, refined.
// V5 R9 (2026-06-19): pronunciation fix — "todo"/"todos" → "to-do"/"to-do items"
//   so ElevenLabs reads English ("too-doo") instead of Spanish ("toe-doe", = "all").

import { createClient } from '@supabase/supabase-js';

// George — rich, deep British male. Closer to original Iron Man Jarvis (Paul Bettany).
const JARVIS_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';

async function buildBriefText(admin) {
  // Pull state in parallel
  const startUtc = new Date();
  startUtc.setUTCHours(0, 0, 0, 0);
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const [todoRes, decRes, agentRes, debriefRes, mrrRes, activityRes, incRes] = await Promise.all([
    admin.from('heath_todo').select('id, title, priority', { count: 'exact' }).eq('status', 'pending').order('priority', { ascending: true }).limit(20),
    admin.from('decision_queue').select('id, title', { count: 'exact' }).eq('status', 'pending'),
    admin.from('agent_state').select('agent_name, status').eq('status', 'working'),
    admin.from('daily_debriefs').select('summary, debrief_date').order('debrief_date', { ascending: false }).limit(1),
    admin.from('money_pulse_snapshots').select('mtd_revenue_usd, mtd_spend_usd').order('captured_at', { ascending: false }).limit(1),
    admin.from('agent_activity').select('agent_name, task_summary').gte('created_at', dayAgo).order('created_at', { ascending: false }).limit(5),
    admin.from('cron_runs').select('cron_name').neq('last_status', 'ok').gte('last_run', dayAgo),
  ]);

  const todoCount = todoRes.count || todoRes.data?.length || 0;
  const decisionCount = decRes.count || decRes.data?.length || 0;
  const activeAgents = (agentRes.data || []).map(a => a.agent_name);
  const debrief = debriefRes.data?.[0]?.summary || '';
  const mrr = Number(mrrRes.data?.[0]?.mtd_revenue_usd || 0);
  const incidents = incRes.data?.length || 0;

  const topTodo = todoRes.data?.[0];
  const topAgent = activityRes.data?.[0];

  const parts = [];
  parts.push('Good morning Heath.');
  parts.push(`Here's what's on your radar.`);
  parts.push(`${todoCount} ${todoCount === 1 ? 'to-do' : 'to-do items'} pending.`);
  parts.push(`${decisionCount} ${decisionCount === 1 ? 'decision' : 'decisions'} waiting on you.`);
  if (mrr > 0) parts.push(`Month-to-date revenue is ${formatCurrency(mrr)}.`);
  if (incidents) parts.push(`${incidents} incidents in the last 24 hours.`);
  if (activeAgents.length) parts.push(`${activeAgents.length} ${activeAgents.length === 1 ? 'agent is' : 'agents are'} currently working.`);
  if (topAgent?.task_summary) {
    parts.push(`${capitalize(topAgent.agent_name)} is on ${topAgent.task_summary}.`);
  }
  if (topTodo?.title) {
    parts.push(`Top priority: ${topTodo.title}.`);
  }
  if (debrief) parts.push(`Last night's debrief: ${debrief}`);

  return {
    text: parts.join(' '),
    counts: { todo: todoCount, decisions: decisionCount, agents_active: activeAgents.length, incidents },
    top_todo: topTodo?.title || null,
    mtd_revenue: mrr,
  };
}

function capitalize(s) { return (s || '').charAt(0).toUpperCase() + (s || '').slice(1); }
function formatCurrency(n) {
  return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthorized' });
  const token = auth.slice(7);

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: 'supabase_env_missing' });
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return res.status(401).json({ error: 'invalid_token' });
  if (userData.user.email !== 'heath.shepard@kw.com') return res.status(403).json({ error: 'forbidden' });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const brief = await buildBriefText(admin);

  const speak = req.query.speak === '1' || req.query.speak === 'true';

  if (!speak) {
    return res.status(200).json({ ok: true, ...brief });
  }

  // ElevenLabs Daniel voice (Jarvis)
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  if (!ELEVENLABS_API_KEY) {
    return res.status(503).json({ error: 'elevenlabs_env_missing', ...brief });
  }
  try {
    // V5 R7.1 (2026-06-18): drop streaming-latency optimization (we fully buffer
    // server-side anyway, so its re-encode just hurts audio quality), bump bitrate
    // 128→192 for cleaner mobile decode. Stutter fix.
    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${JARVIS_VOICE_ID}?output_format=mp3_44100_192`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text: brief.text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true },
      }),
    });
    if (!ttsRes.ok) {
      const errText = await ttsRes.text();
      console.warn('[morning-brief] elevenlabs failed:', ttsRes.status, errText);
      return res.status(502).json({ error: 'tts_failed', detail: errText, ...brief });
    }
    const buf = Buffer.from(await ttsRes.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-Brief-Text', encodeURIComponent(brief.text));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buf);
  } catch (err) {
    console.error('[morning-brief] error:', err);
    return res.status(500).json({ error: 'internal', detail: String(err?.message || err), ...brief });
  }
}
