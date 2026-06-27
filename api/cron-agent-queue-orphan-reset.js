'use strict';

// api/cron-agent-queue-orphan-reset.js
// =============================================================================
// Vercel Serverless Function: /api/cron-agent-queue-orphan-reset
//
// WHY THIS EXISTS
//   cron-agent-queue-dispatch claims an agent_queue row (status='in_progress',
//   started_at=now()), calls Anthropic, then writes back the result. If the
//   Anthropic call times out PAST the Vercel function budget (60s hard cap), or
//   if the function crashes between claim and write-back, the row is left
//   ORPHANED in 'in_progress' forever. The existing cron-agent-queue-tick
//   sweeper only inspects agent_state.last_heartbeat_at (the dead local-poller
//   era pattern) — it does NOT cover server-side dispatcher orphans.
//
//   2026-06-26 21:14-21:39 UTC: dispatcher claimed 9 rows during the
//   Anthropic-slowdown window. None completed. They sat in_progress for 18h,
//   blocking the dispatcher pool (MAX_PER_RUN budget + in_progress slots).
//   Atlas detected + manually reset them on 2026-06-27. This cron prevents
//   recurrence.
//
// WHAT IT DOES
//   Every 30 minutes:
//     1. SELECT FROM agent_queue WHERE status='in_progress'
//        AND started_at < now() - interval '4 hours'
//     2. PATCH each: status='pending', started_at=null,
//        completed_by_agent_session=null, metadata.* augmented with audit trail
//        (_orphan_reset_at, _orphan_reset_by, _orphan_prev_started_at,
//        _orphan_reset_count incremented).
//     3. Log row count + IDs to cron_runs.last_meta + console.
//     4. If reset count >= 5 in a single run, Telegram Heath — that's a signal
//        the dispatcher is failing systematically, not just a one-off timeout.
//
// SAFETY
//   - 4h cutoff. The dispatcher's FETCH_TIMEOUT_MS is 45s + Vercel function
//     cap is 60s. Any row in_progress for >4h is unambiguously dead.
//   - Only flips in_progress → pending. Never touches completed/blocked/failed.
//   - Preserves prior started_at in metadata so we can diagnose patterns.
//
// AUTH
//   Bearer ${CRON_SECRET} OR x-vercel-cron header.
//
// SCHEDULE
//   Every 30 minutes via vercel.json.
//
// OWNER
//   Atlas, 2026-06-27 (post-orphan-incident).

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID          = process.env.TELEGRAM_CHAT_ID || '7874782923';

const ORPHAN_AGE_HOURS    = 4;     // in_progress rows older than this = orphans
const BURST_ALERT_THRESHOLD = 5;   // >=5 orphans in one run pings Heath

// ─── Supabase REST helper ────────────────────────────────────────────────────

async function sb(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
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
    console.warn('[cron-agent-queue-orphan-reset] telegram failed:', e.message);
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

async function handler(req, res) {
  const auth = req.headers.authorization || '';
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const isCronSecret = CRON_SECRET && auth === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isCronSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'missing_supabase_env' });
  }

  const cutoffIso = new Date(Date.now() - ORPHAN_AGE_HOURS * 3600 * 1000).toISOString();

  // 1. Find orphans.
  const find = await sb(
    `agent_queue?select=id,agent_name,task_subject,started_at,metadata` +
      `&status=eq.in_progress&started_at=lt.${encodeURIComponent(cutoffIso)}` +
      `&order=started_at.asc&limit=50`,
  );
  if (!find.ok) {
    return res.status(500).json({ ok: false, error: `supabase_find_${find.status}` });
  }
  const orphans = Array.isArray(find.data) ? find.data : [];
  if (orphans.length === 0) {
    return res.status(200).json({ ok: true, reset_count: 0, cutoff: cutoffIso });
  }

  // 2. Reset each. We patch one row at a time so the audit metadata reflects
  //    the row's previous started_at (we can't batch-patch with per-row JSON).
  const resetIds = [];
  const failures = [];
  const nowIso = new Date().toISOString();

  for (const row of orphans) {
    const prevMeta = row.metadata || {};
    const prevResetCount = Number(prevMeta._orphan_reset_count || 0);

    const newMeta = {
      ...prevMeta,
      _orphan_reset_at: nowIso,
      _orphan_reset_by: 'cron-agent-queue-orphan-reset',
      _orphan_reset_count: prevResetCount + 1,
      _orphan_prev_started_at: row.started_at,
      _orphan_age_hours: Math.round(
        (Date.now() - new Date(row.started_at).getTime()) / 3600000,
      ),
    };

    const patch = await sb(`agent_queue?id=eq.${row.id}&status=eq.in_progress`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'pending',
        started_at: null,
        completed_by_agent_session: null,
        metadata: newMeta,
      }),
    });

    if (patch.ok) {
      resetIds.push({
        id: row.id,
        agent: row.agent_name,
        subject: (row.task_subject || '').slice(0, 80),
        age_h: newMeta._orphan_age_hours,
      });
      console.log(
        `[orphan-reset] reset ${row.id} (${row.agent_name}, ${newMeta._orphan_age_hours}h old, reset_count=${newMeta._orphan_reset_count})`,
      );
    } else {
      failures.push({ id: row.id, status: patch.status });
    }
  }

  // 3. If this is a burst (>=5), tell Heath — dispatcher is misbehaving.
  if (resetIds.length >= BURST_ALERT_THRESHOLD) {
    const sample = resetIds.slice(0, 3).map((r) => `${r.agent}/${r.subject.slice(0, 40)}`).join('; ');
    await tg(
      `[queue orphan-reset] Reset ${resetIds.length} stale in_progress rows ` +
        `(>${ORPHAN_AGE_HOURS}h old). Sample: ${sample}. ` +
        `Dispatcher likely failed mid-Anthropic-call. Check /api/cron-agent-queue-dispatch logs.`,
    );
  }

  return res.status(200).json({
    ok: true,
    reset_count: resetIds.length,
    failure_count: failures.length,
    failures,
    reset: resetIds,
    cutoff: cutoffIso,
    at: nowIso,
  });
}

module.exports = withTelemetry('cron-agent-queue-orphan-reset', handler);
