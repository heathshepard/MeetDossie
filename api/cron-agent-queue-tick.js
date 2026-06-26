// Vercel Serverless Function: /api/cron-agent-queue-tick
//
// Every-minute orchestration tick. Three jobs:
//   1. STALE SWEEP — any agent_state row marked 'working' whose last_heartbeat
//      is >30 min stale gets flipped back to 'idle' and the associated
//      agent_queue row marked 'blocked' with a stale-heartbeat note. The
//      next tick will then surface a real pending task.
//   2. READINESS LOG — record current pending vs ready vs in_progress counts
//      to cron_runs.last_meta so the Jarvis HUD can chart queue depth.
//   3. DISPATCH-HEALTH ALERT — if rows have been pending+ready for >10 min
//      and the dispatcher cron hasn't claimed them, ping Heath ONCE per hour.
//      The OLD "Cole local poller may be down" nudge was retired 2026-06-25
//      when cron-agent-queue-dispatch took over as the actual claimer.
//
// The actual agent execution happens server-side now via
// cron-agent-queue-dispatch (every 2 min) which calls Anthropic /v1/messages
// for each ready row. The "local Cole poller" pattern is dead.
//
// Auth: Vercel built-in cron header OR Bearer ${CRON_SECRET}
// Schedule: every 1 minute. Registered in vercel.json.
//
// Owner: Atlas (SV-ENG-AGENT-QUEUE / 2026-06-17, watchdog rewrite 2026-06-25)

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

const STALE_HEARTBEAT_MIN = 30;      // minutes
const DISPATCH_STUCK_MIN = 10;       // ready rows older than this = dispatcher unhealthy
const DISPATCH_ALERT_THROTTLE_MIN = 60; // alert once per hour for same condition

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

// ─── 3. DISPATCH-HEALTH ALERT ────────────────────────────────────────────────
//
// New architecture (2026-06-25): cron-agent-queue-dispatch (every 2 min) is
// the actual claimer. It calls Anthropic for each ready row and writes the
// result back to agent_queue. We no longer ping Heath about idle local
// pollers — that pattern is dead.
//
// What CAN go wrong now:
//   - The dispatch cron stops running (Vercel cap, deploy regression, env-var
//     wipe). Symptom: agent_queue_ready has rows but none get claimed.
//   - Anthropic returns errors and rows ping-pong between pending/in_progress.
//     Symptom: same row sits in `agent_queue_ready` for >10 min.
//
// We alert when EITHER symptom holds:
//   - There exist ready rows older than DISPATCH_STUCK_MIN, AND
//   - cron-agent-queue-dispatch hasn't completed any row in the same window.
//
// Throttled to once per DISPATCH_ALERT_THROTTLE_MIN (60 min) so the same stuck
// state doesn't spam.

async function maybeAlertDispatchStuck(supabase, snapshot) {
  // KILL-SWITCH: Set WATCHDOG_DISABLED=true in Vercel to silence the alert
  // without changing schema. Remove the env var to re-enable.
  if (process.env.WATCHDOG_DISABLED === 'true') {
    return { alerted: false, disabled: true };
  }

  if (snapshot.ready === 0) return { alerted: false, reason: 'no_ready_rows' };

  // Find oldest ready row. If it's younger than DISPATCH_STUCK_MIN, dispatcher
  // just hasn't gotten to it yet (it runs every 2 min) — not an alert.
  const stuckCutoff = new Date(Date.now() - DISPATCH_STUCK_MIN * 60 * 1000).toISOString();
  const { data: oldReady } = await supabase
    .from('agent_queue_ready')
    .select('id, created_at, agent_name, task_subject')
    .lt('created_at', stuckCutoff)
    .order('created_at', { ascending: true })
    .limit(5);

  if (!oldReady || oldReady.length === 0) {
    return { alerted: false, reason: 'ready_rows_fresh' };
  }

  // Did the dispatcher claim anything in the same window? If yes, it's alive
  // — the old ready rows might be unsupported agents or repeated errors,
  // which is a different problem.
  const { data: recentCompletes } = await supabase
    .from('agent_queue')
    .select('id', { count: 'exact', head: false })
    .eq('completed_by_agent_session', 'cron-agent-queue-dispatch')
    .gte('completed_at', stuckCutoff)
    .limit(1);

  const dispatcherAlive = Array.isArray(recentCompletes) && recentCompletes.length > 0;
  if (dispatcherAlive) {
    return { alerted: false, reason: 'dispatcher_alive', stuck_ready: oldReady.length };
  }

  // Throttle: read the dedicated watchdog-state row so we don't depend on the
  // wrapper-managed cron_runs row (which gets overwritten every run). We use
  // a separate cron_name key ('cron-agent-queue-tick-watchdog') as a tiny
  // K/V store for the last alert timestamp.
  const throttleCutoffMs = Date.now() - DISPATCH_ALERT_THROTTLE_MIN * 60 * 1000;
  const { data: watchdogRow } = await supabase
    .from('cron_runs')
    .select('last_run, last_meta')
    .eq('cron_name', 'cron-agent-queue-tick-watchdog')
    .maybeSingle();

  const lastAlertIso = watchdogRow && watchdogRow.last_meta && watchdogRow.last_meta.dispatch_alert_at;
  const lastAlertMs = lastAlertIso ? new Date(lastAlertIso).getTime() : 0;
  if (lastAlertMs && lastAlertMs > throttleCutoffMs) {
    return { alerted: false, reason: 'throttled', stuck_ready: oldReady.length };
  }

  const oldestAgeMin = Math.round(
    (Date.now() - new Date(oldReady[0].created_at).getTime()) / 60000,
  );
  await tg(
    `[queue watchdog] Dispatcher appears stuck: ${oldReady.length} ready task(s) older than ${DISPATCH_STUCK_MIN}min ` +
      `(oldest ${oldestAgeMin}min, ${oldReady[0].agent_name} / "${(oldReady[0].task_subject || '').slice(0, 60)}") ` +
      `AND no dispatch-cron completions in same window. Check /api/cron-agent-queue-dispatch logs.`,
  );

  // Persist the alert timestamp so the throttle holds across ticks.
  const alertedAt = new Date().toISOString();
  await supabase
    .from('cron_runs')
    .upsert(
      {
        cron_name: 'cron-agent-queue-tick-watchdog',
        last_run: alertedAt,
        last_status: 'alerted',
        last_meta: { dispatch_alert_at: alertedAt, stuck_ready: oldReady.length, oldest_age_min: oldestAgeMin },
      },
      { onConflict: 'cron_name' },
    );

  return {
    alerted: true,
    dispatch_alert_at: alertedAt,
    stuck_ready: oldReady.length,
    oldest_age_min: oldestAgeMin,
  };
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
  const dispatch_alert = await maybeAlertDispatchStuck(supabase, snapshot);

  return res.status(200).json({
    ok: true,
    at: new Date().toISOString(),
    sweep,
    snapshot,
    dispatch_alert,
  });
});
