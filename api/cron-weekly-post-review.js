'use strict';

// api/cron-weekly-post-review.js
// =============================================================================
// Phase 5 — Weekly AI feedback loop.
// Fires Mondays 6am CDT (11 UTC). Aggregates last-7d post_analytics, ships the
// dataset to the Claude Code CLI worker (Max-billed) as task_type=
// 'sage_weekly_review'. Fable analyzes hook_type / cta_type / hook_variant A/B
// / trending sounds — writes ranked recommendations into sage_weekly_reviews.
//
// The report file lands at:
//   C:/Users/Heath Shepard/Desktop/Shepard-Ventures/Marketing/sage/
//     weekly-review-YYYY-MM-DD.md
// (Written by the worker handler, path stored on sage_weekly_reviews.report_path.)
//
// Schedule: "0 11 * * 1" (Mon 6am CDT).
// Owner: Atlas 2026-07-08.
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

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

async function enqueueClaudeCodeTask(host, body) {
  const url = `${host}/api/claude-code-enqueue`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CRON_SECRET}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  // Compute the trailing 7-day window (Mon..Sun of the just-ended week).
  const today = new Date();
  const weekEnd = new Date(today);
  weekEnd.setUTCHours(23, 59, 59, 999);
  weekEnd.setUTCDate(weekEnd.getUTCDate() - 1); // yesterday (Sunday)
  const weekStart = new Date(weekEnd);
  weekStart.setUTCDate(weekStart.getUTCDate() - 6);
  weekStart.setUTCHours(0, 0, 0, 0);

  const weekStartDate = weekStart.toISOString().slice(0, 10);
  const weekEndDate = weekEnd.toISOString().slice(0, 10);

  // Pull the analytics window.
  const analyticsR = await sb(
    `post_analytics?select=id,platform,persona,hook,hook_type,cta_type,hook_variant,sound_id,sound_title,likes,comments,shares,saves,clicks,views,engagement_rate,engagement_score,synced_at&synced_at=gte.${weekStart.toISOString()}&synced_at=lte.${weekEnd.toISOString()}&order=synced_at.desc&limit=1000`
  );
  if (!analyticsR.ok) {
    return res.status(500).json({ ok: false, error: `analytics_query_failed:${analyticsR.status}` });
  }
  const rows = Array.isArray(analyticsR.data) ? analyticsR.data : [];

  // If the window has no rows, log + exit success (nothing to review yet).
  if (rows.length === 0) {
    return res.status(200).json({
      ok: true,
      skipped: true,
      reason: 'no_analytics_rows_in_window',
      week_start: weekStartDate,
      week_end: weekEndDate,
    });
  }

  // Dedup: only skip if we already have a review row for this week_start.
  const existingR = await sb(
    `sage_weekly_reviews?select=id&week_start=eq.${weekStartDate}&limit=1`
  );
  if (existingR.ok && Array.isArray(existingR.data) && existingR.data.length > 0) {
    return res.status(200).json({
      ok: true, dedup: true, review_id: existingR.data[0].id,
    });
  }

  // Fire the enqueue against the same host we were called on.
  const host = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
  const enq = await enqueueClaudeCodeTask(host, {
    task_type: 'sage_weekly_review',
    agent_name: 'sage',
    priority: 3,
    title: `Sage weekly review ${weekStartDate}..${weekEndDate}`,
    description: 'Analyze last-7d post_analytics, rank hook_type/cta_type/hook_variant/sounds, write recommendations.',
    idempotency_key: `sage_weekly_review:${weekStartDate}`,
    payload: {
      week_start: weekStartDate,
      week_end: weekEndDate,
      posts_analyzed: rows.length,
      rows,   // handler will read and rank
    },
  });

  if (!enq.ok) {
    return res.status(502).json({ ok: false, error: 'enqueue_failed', detail: enq.data });
  }

  return res.status(200).json({
    ok: true,
    week_start: weekStartDate,
    week_end: weekEndDate,
    posts_queued: rows.length,
    queue_id: enq.data && enq.data.queue_id,
  });
}

module.exports = withTelemetry('cron-weekly-post-review', handler);
