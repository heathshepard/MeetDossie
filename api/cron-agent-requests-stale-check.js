'use strict';

// api/cron-agent-requests-stale-check.js
// =============================================================================
// Vercel Serverless Function: /api/cron-agent-requests-stale-check
//
// WHY THIS EXISTS
//   cron-agent-queue-orphan-reset covers stuck rows in `agent_queue` (the
//   Jarvis/Cole-dispatch table). It does NOT cover `agent_requests` (the
//   separate dispatch queue behind cron-process-agent-requests) — that queue
//   had NO safety net at all.
//
//   Found live while building this (2026-08-25): `agent_requests` had 825
//   rows stuck in status='pending', oldest from 2026-06-10 — 2.5 months old.
//   Only 1 row (the id=1 seed row from table creation) had EVER reached
//   status='complete'. Root cause: cron_runs shows the last logged run of
//   cron-process-agent-requests was 2026-08-12, ending in http_401 — the
//   cron-job.org trigger is sending a stale/wrong CRON_SECRET. Confirmed the
//   endpoint itself is healthy: calling it directly with the current
//   CRON_SECRET processed 5 rows successfully. So the dispatcher code works;
//   the external scheduler auth is broken, and it broke silently because
//   withTelemetry deliberately stopped recording 401s to cron_runs on
//   2026-08-14 (correct fix for a different false-alarm bug, but it means a
//   *persistently* wrong secret now looks identical to "nothing has tried to
//   run since Aug 12" — cron_runs goes stale and nobody is told).
//
//   This endpoint is the independent, telemetry-blind-spot-proof check: it
//   reads `agent_requests` directly, not cron_runs, so it catches "the whole
//   dispatcher is dead" as well as "one row got orphaned mid-run."
//
// WHAT IT DOES
//   1. STALE IN-PROGRESS (auto-reset): rows with status='in_progress' and
//      created_at older than STALE_IN_PROGRESS_MINUTES get flipped back to
//      'pending' so the next dispatcher tick retries them. Safe because
//      cron-process-agent-requests has a 60s Vercel maxDuration and sets
//      in_progress synchronously right before its one Anthropic call in the
//      same invocation — anything still in_progress after 5 minutes is
//      unambiguously a dead/crashed invocation, not a slow one.
//   2. STALE PENDING BACKLOG (alert-only, never mutated): if the oldest
//      pending row is older than STALE_PENDING_MINUTES, or the pending count
//      exceeds BACKLOG_ALERT_COUNT, ping Heath. This is the "dispatcher isn't
//      running at all" signal — pending rows are real, valid work; we never
//      touch them, only surface that they're piling up.
//   3. Telegram alert via the plain bot (not gated off — see ALWAYS_ALLOW
//      addition in telegram-gate.js). Fires only when something's actually
//      stuck; silent on a healthy queue.
//
// SAFETY
//   - Only status flip is in_progress -> pending, guarded by a
//     status=eq.in_progress filter on the patch so a row that completes in
//     the gap between read and write is never clobbered.
//   - Pending rows are NEVER mutated by this cron — only reported on.
//
// AUTH
//   Bearer ${CRON_SECRET} OR x-vercel-cron header.
//
// SCHEDULE
//   Not in vercel.json `crons` (20/20 Vercel cron cap reached, per CLAUDE.md).
//   Register at cron-job.org, every 15 minutes, same pattern as
//   cron-process-agent-requests:
//     URL:    https://meetdossie.com/api/cron-agent-requests-stale-check
//     Header: Authorization: Bearer <CRON_SECRET>
//
// OWNER
//   Atlas, 2026-08-25.

require('./_lib/telegram-gate').install('cron-agent-requests-stale-check');

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID          = process.env.TELEGRAM_CHAT_ID || '7874782923';

const STALE_IN_PROGRESS_MINUTES = 5;   // dead-invocation cutoff (60s maxDuration + margin)
const STALE_PENDING_MINUTES     = 15;  // oldest-pending age that signals dispatcher isn't keeping up
const BACKLOG_ALERT_COUNT       = 20;  // absolute pending count that signals dispatcher isn't keeping up

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
    console.warn('[cron-agent-requests-stale-check] telegram failed:', e.message);
  }
}

function minutesAgo(iso) {
  return Math.round((Date.now() - new Date(iso).getTime()) / 60000);
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

  // ── 1. Stale in_progress: auto-reset to pending ──────────────────────────
  const inProgressCutoff = new Date(Date.now() - STALE_IN_PROGRESS_MINUTES * 60 * 1000).toISOString();
  const stuck = await sb(
    `agent_requests?select=request_id,to_agent,from_agent,created_at` +
      `&status=eq.in_progress&created_at=lt.${encodeURIComponent(inProgressCutoff)}` +
      `&order=created_at.asc&limit=50`,
  );
  if (!stuck.ok) {
    return res.status(500).json({ ok: false, error: `supabase_find_stuck_${stuck.status}` });
  }

  const stuckRows = Array.isArray(stuck.data) ? stuck.data : [];
  const resetIds = [];
  for (const row of stuckRows) {
    const patch = await sb(
      `agent_requests?request_id=eq.${encodeURIComponent(row.request_id)}&status=eq.in_progress`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'pending' }),
      },
    );
    if (patch.ok) {
      resetIds.push({
        request_id: row.request_id,
        to_agent: row.to_agent,
        age_min: minutesAgo(row.created_at),
      });
    }
  }

  if (resetIds.length > 0) {
    console.log(
      `[agent-requests-stale-check] reset ${resetIds.length} dead in_progress rows back to pending`,
    );
    await tg(
      `[agent_requests] Reset ${resetIds.length} row(s) stuck in_progress >${STALE_IN_PROGRESS_MINUTES}m ` +
        `(dead dispatcher invocation) back to pending for retry. Sample: ` +
        resetIds.slice(0, 3).map((r) => `${r.to_agent}/${r.request_id.slice(0, 8)} (${r.age_min}m)`).join(', '),
    );
  }

  // ── 2. Stale pending backlog: alert only, never mutate ───────────────────
  const pendingCutoff = new Date(Date.now() - STALE_PENDING_MINUTES * 60 * 1000).toISOString();
  const oldestPending = await sb(
    `agent_requests?select=request_id,to_agent,from_agent,created_at` +
      `&status=eq.pending&order=created_at.asc&limit=5`,
  );
  if (!oldestPending.ok) {
    return res.status(500).json({ ok: false, error: `supabase_find_pending_${oldestPending.status}` });
  }
  const oldestRows = Array.isArray(oldestPending.data) ? oldestPending.data : [];

  // Exact pending count comes from the content-range header, not the body,
  // so fetch directly here rather than through sb() (which discards headers).
  let pendingTotal = 0;
  try {
    const headRes = await fetch(
      `${SUPABASE_URL}/rest/v1/agent_requests?select=request_id&status=eq.pending&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: 'count=exact',
        },
      },
    );
    const range = headRes.headers.get('content-range') || '';
    const m = /\/(\d+)$/.exec(range);
    pendingTotal = m ? Number(m[1]) : 0;
  } catch (e) {
    console.warn('[agent-requests-stale-check] pending count fetch failed:', e.message);
  }

  const oldest = oldestRows[0] || null;
  const oldestAgeMin = oldest ? minutesAgo(oldest.created_at) : 0;
  const backlogIsStale = !!oldest && oldestAgeMin > STALE_PENDING_MINUTES;
  const backlogIsBig = pendingTotal > BACKLOG_ALERT_COUNT;

  if (backlogIsStale || backlogIsBig) {
    await tg(
      `[agent_requests] Backlog alert: ${pendingTotal} row(s) pending, oldest is ${oldestAgeMin}m old ` +
        `(threshold ${STALE_PENDING_MINUTES}m / ${BACKLOG_ALERT_COUNT} rows). If this keeps growing, ` +
        `cron-process-agent-requests likely isn't firing — check the cron-job.org job's auth header ` +
        `against the current CRON_SECRET (cron_runs table won't show this: 401s aren't logged there).`,
    );
  }

  return res.status(200).json({
    ok: true,
    reset_count: resetIds.length,
    reset: resetIds,
    pending_total: pendingTotal,
    oldest_pending_age_min: oldestAgeMin,
    backlog_alerted: backlogIsStale || backlogIsBig,
  });
}

module.exports = withTelemetry('cron-agent-requests-stale-check', handler);
