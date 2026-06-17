// Vercel Serverless Function: /api/cron-agent-queue-tick
//
// Every-minute orchestration tick. Three jobs:
//   1. STALE SWEEP — any agent_state row marked 'working' whose last_heartbeat
//      is >30 min stale gets flipped back to 'idle' and the associated
//      agent_queue row marked 'blocked' with a stale-heartbeat note. The
//      next tick will then surface a real pending task.
//   2. READINESS LOG — record current pending vs ready vs in_progress counts
//      to cron_runs.last_meta so the Jarvis HUD can chart queue depth.
//   3. NUDGE — when an agent is idle AND has a ready task, POST a
//      notification to Cole's webhook so the local Cole session knows to
//      claim it without waiting for its 30s poll. This is the "agents never
//      idle" enforcement: as soon as a task lands, Cole knows.
//
// IMPORTANT: This cron does NOT spawn agents directly. The actual spawning
// happens locally inside Cole's always-on Claude Code session (which calls
// /api/agent-queue-claim every 30s and runs the agent against the task brief).
// Server-side spawning is a fallback we'll add in Phase 2 (cron-process-agent-
// requests pattern) once the local poller is proven.
//
// WHY: Vercel cron-job functions can't open a long-lived Claude Code session.
// The agent files live on Heath's laptop (~/.claude/agents/). Trying to spawn
// them from Vercel means re-implementing the agent runtime in a serverless
// function. The local poller pattern reuses everything we already have.
//
// Auth: Vercel built-in cron header OR Bearer ${CRON_SECRET}
// Schedule: every 1 minute. Registered in vercel.json OR cron-job.org if we're
//           at the Vercel cron cap.
//
// Owner: Atlas (SV-ENG-AGENT-QUEUE / 2026-06-17)

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

const STALE_HEARTBEAT_MIN = 30; // minutes
const NUDGE_THROTTLE_MIN = 10;  // don't Telegram-spam Cole

function checkAuth(req) {
  if (req.headers['x-vercel-cron'] === '1') return true;
  const h = req.headers.authorization || '';
  return !!CRON_SECRET && h === `Bearer ${CRON_SECRET}`;
}

// ─── 1. STALE SWEEP ──────────────────────────────────────────────────────────

async function sweepStale(supabase) {
  const cutoffMin = STALE_HEARTBEAT_MIN;
  const cutoff = new Date(Date.now() - cutoffMin * 60 * 1000).toISOString();

  // Find working agents whose heartbeat went stale.
  const { data: stale } = await supabase
    .from('agent_state')
    .select('agent_name, current_task_id, last_heartbeat_at')
    .eq('status', 'working')
    .lt('last_heartbeat_at', cutoff);

  if (!stale || stale.length === 0) return { stale_count: 0, stale_agents: [] };

  const staleAgents = [];

  for (const a of stale) {
    // Mark the in-flight task blocked with a note (only if we have a task id).
    if (a.current_task_id) {
      const { data: row } = await supabase
        .from('agent_queue')
        .select('metadata, status')
        .eq('id', a.current_task_id)
        .single();
      if (row && row.status === 'in_progress') {
        const meta = { ...(row.metadata || {}), _stale_at: new Date().toISOString(), _reason: `heartbeat >${cutoffMin}min stale` };
        await supabase
          .from('agent_queue')
          .update({ status: 'blocked', metadata: meta })
          .eq('id', a.current_task_id);
      }
    }
    // Reset the agent to idle so the picker can give them a fresh task.
    await supabase
      .from('agent_state')
      .update({ status: 'idle', current_task_id: null, last_heartbeat_at: new Date().toISOString() })
      .eq('agent_name', a.agent_name);
    staleAgents.push(a.agent_name);
  }

  // Alert Cole via Telegram — these are real anomalies.
  if (staleAgents.length > 0) {
    await tg(`Queue sweep: ${staleAgents.length} agent(s) marked stale (heartbeat >${cutoffMin}min): ${staleAgents.join(', ')}. Their in-flight tasks were moved to 'blocked'.`);
  }

  return { stale_count: staleAgents.length, stale_agents: staleAgents };
}

// ─── 2. READINESS LOG ────────────────────────────────────────────────────────

async function snapshotQueue(supabase) {
  const out = {};
  for (const status of ['pending', 'in_progress', 'blocked', 'completed']) {
    const { count } = await supabase
      .from('agent_queue')
      .select('id', { count: 'exact', head: true })
      .eq('status', status);
    out[status] = count || 0;
  }
  // ready = pending with deps satisfied
  const { count: readyCount } = await supabase
    .from('agent_queue_ready')
    .select('id', { count: 'exact', head: true });
  out.ready = readyCount || 0;

  // agent_state breakdown
  const { data: states } = await supabase
    .from('agent_state')
    .select('agent_name, status');
  const byStatus = { working: 0, idle: 0, sleeping: 0, unavailable: 0 };
  for (const s of (states || [])) {
    if (byStatus[s.status] !== undefined) byStatus[s.status] += 1;
  }
  out.agents = byStatus;

  return out;
}

// ─── 3. NUDGE COLE ───────────────────────────────────────────────────────────
//
// If we have idle agents AND ready tasks, Cole's local poller should claim
// them within ~30s on its own. We only ping when the situation has held for
// >NUDGE_THROTTLE_MIN minutes, which implies the local Cole isn't running.

async function maybeNudge(supabase, snapshot) {
  const idleAgentsWithReadyWork = snapshot.agents.idle > 0 && snapshot.ready > 0;
  if (!idleAgentsWithReadyWork) return { nudged: false };

  // Throttle: only nudge once per NUDGE_THROTTLE_MIN window.
  const sinceIso = new Date(Date.now() - NUDGE_THROTTLE_MIN * 60 * 1000).toISOString();
  const { data: recentNudge } = await supabase
    .from('cron_runs')
    .select('last_run, last_meta')
    .eq('cron_name', 'cron-agent-queue-tick')
    .gte('last_run', sinceIso)
    .order('last_run', { ascending: false })
    .limit(1);

  const alreadyNudged = (recentNudge || []).some((r) => r.last_meta && r.last_meta.nudged_at);
  if (alreadyNudged) return { nudged: false, throttled: true };

  // The "ready but no one is claiming" signal usually means Cole's local
  // session died. Tell Heath via Telegram so he can restart it.
  await tg(`Queue tick: ${snapshot.ready} ready task(s) but ${snapshot.agents.idle} agents are idle and no claims in last ${NUDGE_THROTTLE_MIN}min. Cole local poller may be down — check Claude Code session.`);
  return { nudged: true, nudged_at: new Date().toISOString() };
}

async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
  } catch (e) {
    console.warn('[cron-agent-queue-tick] telegram failed:', e.message);
  }
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────

module.exports = withTelemetry('cron-agent-queue-tick', async function handler(req, res) {
  if (!checkAuth(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase env not configured' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const sweep = await sweepStale(supabase);
  const snapshot = await snapshotQueue(supabase);
  const nudge = await maybeNudge(supabase, snapshot);

  return res.status(200).json({
    ok: true,
    at: new Date().toISOString(),
    sweep,
    snapshot,
    nudge,
  });
});
