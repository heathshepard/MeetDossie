'use strict';

// api/cron-social-cadence.js
// =============================================================================
// Phase 5 — Cadence cron.
// Fires 4x daily (7am, 10am, 1pm, 6pm CDT). Pops the next batch-approved,
// cadence-queued social post and forwards it to Zernio for publish.
//
// Behavior:
//   1. Auth: Bearer CRON_SECRET.
//   2. Load N (default 1) rows from social_posts where:
//        cadence_queue = true
//        batch_approved = true
//        status = 'pending_approval' OR 'approved'
//      ordered by created_at ASC, priority the oldest.
//   3. Flip each row's status to 'approved' + scheduled_for=now(). The existing
//      cron-publish-approved (every 30 min) will pick it up on next tick, or
//      we can call the same publisher inline — we choose the cheap path:
//      just flip to 'approved' + let cron-publish-approved fan out. Loose
//      coupling, no duplicate Zernio logic.
//   4. Increment a lightweight per-slot audit trail via cron-telemetry.
//   5. HARD GATE — SAFETY: cadence cron never fires publishes on its own if
//      env var SOCIAL_CADENCE_PAUSED=1 is set. Heath can pause without a code
//      change. Also aborts if today's cadence limit (default 6) already hit.
//
// Schedule: 12,15,18,23 UTC (7am/10am/1pm/6pm CDT). Registered in vercel.json.
// Owner: Atlas 2026-07-08 (SV-SAGE-PHASE5).
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const CADENCE_DAILY_CAP = Number(process.env.SOCIAL_CADENCE_DAILY_CAP || 6);
const CADENCE_PER_SLOT = Number(process.env.SOCIAL_CADENCE_PER_SLOT || 2);
const PAUSED = String(process.env.SOCIAL_CADENCE_PAUSED || '0') === '1';

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

async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  if (PAUSED) {
    return res.status(200).json({
      ok: true, paused: true, released: 0,
      reason: 'SOCIAL_CADENCE_PAUSED=1 — no cadence releases this tick.',
    });
  }

  // Count how many cadence-released posts already went out today.
  // A "cadence release" is anything cron flipped from cadence_queue=true to
  // approved. We check posted_at + scheduled_for windows for today (UTC).
  const startOfDayIso = new Date();
  startOfDayIso.setUTCHours(0, 0, 0, 0);
  const startIso = startOfDayIso.toISOString();

  const releasedTodayR = await sb(
    `social_posts?select=id,approved_at&cadence_queue=eq.true&status=in.(approved,publishing,posted)&approved_at=gte.${startIso}`
  );
  const releasedToday = releasedTodayR.ok && Array.isArray(releasedTodayR.data)
    ? releasedTodayR.data.length : 0;

  if (releasedToday >= CADENCE_DAILY_CAP) {
    return res.status(200).json({
      ok: true, capped: true, released_today: releasedToday, cap: CADENCE_DAILY_CAP,
    });
  }

  const remainingToday = CADENCE_DAILY_CAP - releasedToday;
  const takeThisTick = Math.min(CADENCE_PER_SLOT, remainingToday);

  // Grab N eligible posts.
  const pickR = await sb(
    `social_posts?select=id,platform,persona,hook,content&cadence_queue=eq.true&batch_approved=eq.true&status=in.(pending_approval,approved,draft)&order=created_at.asc&limit=${takeThisTick}`
  );
  if (!pickR.ok) {
    return res.status(500).json({ ok: false, error: `pick_failed:${pickR.status}`, detail: pickR.data });
  }
  const picks = Array.isArray(pickR.data) ? pickR.data : [];

  const released = [];
  const failed = [];
  const nowIso = new Date().toISOString();

  for (const post of picks) {
    // Soft lock via conditional PATCH: only flip if still eligible.
    const patch = await sb(
      `social_posts?id=eq.${post.id}&cadence_queue=eq.true&status=in.(pending_approval,approved,draft)`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          status: 'approved',
          approved_at: nowIso,
          scheduled_for: nowIso,
        }),
      }
    );
    if (patch.ok && Array.isArray(patch.data) && patch.data.length > 0) {
      released.push({ id: post.id, platform: post.platform });
    } else {
      failed.push({ id: post.id, reason: `patch_status_${patch.status}` });
    }
  }

  return res.status(200).json({
    ok: true,
    tick: nowIso,
    released_count: released.length,
    released_today_after: releasedToday + released.length,
    cap: CADENCE_DAILY_CAP,
    released,
    failed,
    note: 'Released posts will be picked up by cron-publish-approved on the next 30-min tick.',
  });
}

module.exports = withTelemetry('cron-social-cadence', handler);
