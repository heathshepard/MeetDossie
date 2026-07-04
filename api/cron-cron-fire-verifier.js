const { withTelemetry } = require('./_lib/cron-telemetry.js');

'use strict';

// api/cron-cron-fire-verifier.js
//
// SV-ENG-RELIABILITY-001 (Atlas, 2026-06-11)
//
// CRON-FIRE VERIFIER. Runs daily at 5 AM CDT (10:00 UTC). For each registered
// cron in the canonical list, check the last_run timestamp in cron_runs. Any
// cron that hasn't fired in its expected window (3x its frequency) →
//
//   1. Manually fire it (GET /api/<name> with Bearer CRON_SECRET).
//   2. Append a wall_log_entries row describing the miss + the route-around.
//   3. Telegram-ping Cole's chat (NOT Heath) UNLESS the miss is catastrophic
//      (>=3 critical crons missed the same morning) in which case we ping Heath.
//
// "Catastrophic" = the publish lane or generate lane both missed.
// Catastrophic crons: cron-generate-posts, cron-publish-approved,
//   cron-mission-watchdog, cron-sage-autonomous-review.
//
// Auth: Bearer ${CRON_SECRET} OR x-vercel-cron.
// Schedule: vercel.json `0 10 * * *`.

const { retryFetch } = require('./_lib/retry.js');
const { logWall, recordCronRun } = require('./_lib/wall-log.js');
const { isPaused, pauseReason } = require('./_lib/paused-crons.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const COLE_TELEGRAM_CHAT_ID = process.env.COLE_TELEGRAM_CHAT_ID || TELEGRAM_CHAT_ID;
const SELF_BASE_URL = process.env.SELF_BASE_URL || 'https://meetdossie.com';

const SELF_NAME = 'cron-cron-fire-verifier';

// Canonical list — mirrors KNOWN_CRONS in api/ventures/cron-health.js plus
// the new reliability crons + the Sage stack + watchdog. expectedMinutes = the
// nominal cycle; a cron is "missed" if last_run is more than 3x older.
//
// Items marked criticalForMission=true escalate to Heath if >=3 missed same morning.
const REGISTERED_CRONS = [
  // Publish + generate (critical to mission)
  { name: 'cron-generate-posts',          schedule: '0 11 * * *',     expectedMinutes: 1440,  criticalForMission: true,  path: '/api/cron-generate-posts' },
  { name: 'cron-publish-approved',        schedule: '*/30 * * * *',   expectedMinutes: 30,    criticalForMission: true,  path: '/api/cron-publish-approved' },
  { name: 'cron-mission-watchdog',        schedule: '0 13-23,0,1 * * *', expectedMinutes: 60, criticalForMission: true,  path: '/api/cron-mission-watchdog' },
  { name: 'cron-sage-autonomous-review',  schedule: '*/30 * * * *',   expectedMinutes: 30,    criticalForMission: true,  path: '/api/cron-sage-autonomous-review' },

  // Sage stack
  { name: 'cron-sage-regenerate',         schedule: '*/30 * * * *',   expectedMinutes: 30,    criticalForMission: false, path: '/api/cron-sage-regenerate' },
  { name: 'cron-sage-first-comment',      schedule: '*/15 * * * *',   expectedMinutes: 15,    criticalForMission: false, path: '/api/cron-sage-first-comment' },
  { name: 'cron-send-to-sage',            schedule: '30 11 * * *',    expectedMinutes: 1440,  criticalForMission: false, path: '/api/cron-send-to-sage' },

  // Veto + first-comment + engagement
  { name: 'cron-engagement-veto-mode',    schedule: '*/30 13-23 * * *', expectedMinutes: 30,  criticalForMission: false, path: '/api/cron-engagement-veto-mode' },
  { name: 'cron-engagement-summary',      schedule: '0 13 * * *',     expectedMinutes: 1440,  criticalForMission: false, path: '/api/cron-engagement-summary' },

  // Health + digest
  { name: 'cron-daily-platform-health',   schedule: '0 3 * * *',      expectedMinutes: 1440,  criticalForMission: false, path: '/api/cron-daily-platform-health' },
  { name: 'cron-morning-ops-digest',      schedule: '0 13 * * *',     expectedMinutes: 1440,  criticalForMission: false, path: '/api/cron-morning-ops-digest' },
  { name: 'cron-pipeline-health',         schedule: '0 13 * * *',     expectedMinutes: 1440,  criticalForMission: false, path: '/api/cron-pipeline-health' },
  // cron-cookie-health-check REMOVED 2026-06-14 (Atlas) — endpoint was deleted
  // as part of SV-ENG-COOKIE-MIGRATION-2026-06-11 (persistent Chrome profile +
  // local keepalive scripts replaced session_health rows). Verifier was
  // re-firing it nightly and getting 404 because the route no longer exists.

  // Verify lane
  { name: 'cron-verify-posts',            schedule: '45 * * * *',     expectedMinutes: 60,    criticalForMission: false, path: '/api/cron-verify-posts' },

  // Heath digest
  { name: 'cron-heath-publish-digest',    schedule: '0 7 * * *',      expectedMinutes: 1440,  criticalForMission: false, path: '/api/cron-heath-publish-digest' },

  // Reliability stack (this batch — verify they fire too)
  { name: 'cron-platform-health-checker', schedule: '0 14-23/2 * * *', expectedMinutes: 120,  criticalForMission: false, path: '/api/cron-platform-health-checker' },
  { name: 'cron-account-session-monitor', schedule: '0 */6 * * *',    expectedMinutes: 360,   criticalForMission: false, path: '/api/cron-account-session-monitor' },
];

async function sb(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

async function tg(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4090),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('[fire-verifier] tg error:', err && err.message);
  }
}

async function fireCron(path) {
  try {
    const url = `${SELF_BASE_URL}${path}`;
    const res = await retryFetch(
      url,
      { method: 'GET', headers: { Authorization: `Bearer ${CRON_SECRET}` } },
      { name: `verifier-${path}`, maxAttempts: 2, baseDelay: 1500 },
    );
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

async function loadLastRuns() {
  const { ok, data } = await sb('/rest/v1/cron_runs?select=cron_name,last_run,last_status&order=last_run.desc.nullslast&limit=500');
  const map = new Map();
  if (!ok || !Array.isArray(data)) return map;
  for (const row of data) {
    if (!map.has(row.cron_name)) {
      map.set(row.cron_name, { lastRun: row.last_run, lastStatus: row.last_status });
    }
  }
  return map;
}

module.exports = withTelemetry('cron-cron-fire-verifier', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const lastRuns = await loadLastRuns();
  const now = Date.now();
  const missed = [];
  const refired = [];
  const skipped = [];
  const skippedPaused = [];

  for (const c of REGISTERED_CRONS) {
    // 2026-07-04 (Atlas) — PAUSE-AWARE GUARD.
    // Cost-freeze crons live at schedule '0 0 1 1 *'. Without this guard the
    // verifier saw them as "silent" and re-fired them at every 5 AM CDT run,
    // burning Anthropic $ per re-fire. isPaused() reads vercel.json's crons
    // list — anything on the freeze schedule OR not registered at all is
    // treated as intentionally paused: skip the re-fire, log telemetry, no
    // alert. See docs/INCIDENT-LOG.md 2026-07-04 for the burn incident.
    if (isPaused(c.path)) {
      const reason = pauseReason(c.path) || 'paused';
      skippedPaused.push({ name: c.name, reason });
      console.log(`[fire-verifier] skipped_paused ${c.name} (${reason}) — freeze-safe, no re-fire`);
      continue;
    }

    const row = lastRuns.get(c.name);
    const lastRun = row && row.lastRun ? new Date(row.lastRun).getTime() : null;
    const ageMin = lastRun ? (now - lastRun) / 60000 : Infinity;
    const threshold = c.expectedMinutes * 3; // 3x the expected cycle = missed

    if (ageMin <= threshold) {
      skipped.push({ name: c.name, ageMin: Math.round(ageMin) });
      continue;
    }

    // Missed — re-fire.
    const fire = await fireCron(c.path);
    missed.push({
      name: c.name,
      ageMin: lastRun ? Math.round(ageMin) : 'never',
      expectedMinutes: c.expectedMinutes,
      criticalForMission: c.criticalForMission,
      refire_ok: fire.ok,
      refire_status: fire.status || null,
    });
    if (fire.ok) refired.push(c.name);

    // Wall-log the miss.
    await logWall({
      wall_id: `WALL-CRON-MISS-${c.name}`,
      title: `${c.name} missed its expected window (${Math.round(ageMin)}m vs ${c.expectedMinutes}m expected)`,
      what_broke: `Cron ${c.name} last ran ${lastRun ? new Date(lastRun).toISOString() : 'never'}; expected every ${c.expectedMinutes} minutes.`,
      detected_by: SELF_NAME,
      root_cause: 'Vercel scheduled cron did not fire (suspect: deployment cooldown, vercel scheduler delay, or invocation failure not captured in cron_runs)',
      route_around: fire.ok ? `${SELF_NAME} re-fired ${c.path} successfully` : `${SELF_NAME} attempted re-fire of ${c.path} but got status=${fire.status || 'error'}`,
      permanent_fix: 'PENDING — investigate Vercel cron logs if this wall_id appears 2+ days running',
      resolved_by: SELF_NAME,
      reoccurrence_guard: `${SELF_NAME} re-checks daily at 5 AM CDT; any miss >=3x cycle triggers refire + this entry`,
      metadata: {
        cron_name: c.name,
        expected_minutes: c.expectedMinutes,
        actual_age_minutes: lastRun ? Math.round(ageMin) : null,
        refire_ok: fire.ok,
        refire_status: fire.status,
      },
    });
  }

  // Decide who to ping. Default = Cole only. Catastrophic = Heath too.
  const criticalMisses = missed.filter((m) => m.criticalForMission);
  const isCatastrophic = criticalMisses.length >= 3;

  if (missed.length > 0) {
    const lines = ['🔔 <b>CRON FIRE VERIFIER</b>', ''];
    lines.push(`Missed: ${missed.length} / ${REGISTERED_CRONS.length}`);
    lines.push(`Re-fired ok: ${refired.length}`);
    if (criticalMisses.length > 0) {
      lines.push(`Critical: ${criticalMisses.map((m) => m.name).join(', ')}`);
    }
    lines.push('');
    for (const m of missed) {
      const tag = m.criticalForMission ? '🚨' : '·';
      lines.push(`${tag} ${m.name} — age=${m.ageMin}m expected=${m.expectedMinutes}m refire=${m.refire_ok ? 'ok' : `fail(${m.refire_status})`}`);
    }
    const msg = lines.join('\n');
    await tg(COLE_TELEGRAM_CHAT_ID, msg);
    if (isCatastrophic && COLE_TELEGRAM_CHAT_ID !== TELEGRAM_CHAT_ID) {
      await tg(TELEGRAM_CHAT_ID, '🚨 CATASTROPHIC: 3+ critical crons missed. See Cole channel for detail.');
    }
  }

  // Record self.
  await recordCronRun(SELF_NAME, missed.length > 0 ? 'recovered' : 'ok');

  return res.status(200).json({
    ok: true,
    checked: REGISTERED_CRONS.length,
    missed: missed.length,
    refired: refired.length,
    skipped_paused: skippedPaused.length,
    catastrophic: isCatastrophic,
    detail: { missed, skipped, skipped_paused: skippedPaused },
  });
});
