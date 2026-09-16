'use strict';

// Vercel Serverless Function: /api/cron-weekly-content-scheduler
//
// WHY (Heath, 2026-09-16, top priority: consistent posting "for months"):
// cron-generate-posts.js only ever generates TODAY's batch. If that one
// 11:00 UTC run fails, or Heath doesn't approve in time, that day's slot is
// gone for good — post_id is date-keyed, so tomorrow's run doesn't (and
// shouldn't) retroactively fill yesterday. There was never a buffer: one
// failed daily run == one silently empty day, discovered only if someone
// happened to check the analytics/silence-alarm afterward.
//
// WHAT THIS DOES, every Monday early AM (before the day's own 11:00 UTC
// generation run):
//   1. For owner='dossie' (the only owner with a real automated generator):
//      walks the next 7 calendar dates. Any date with zero existing
//      social_posts rows gets a real advance-fill call to
//      cron-generate-posts.js's ?target_date=YYYY-MM-DD path (added
//      2026-09-16 alongside this file) — same verifier gate, same
//      posting_schedule.is_active platform filter, same on_conflict=post_id
//      idempotency as the daily run. A date that already has rows (from a
//      prior run of this scheduler, or the daily cron beating it to a
//      same-day re-run) is left alone — never double-generates.
//   2. For owner='heath-realtor': reports the same day-by-day supply
//      picture, but never attempts generation — cron-daily-listing-posts.js
//      has been serverless-disabled since 2026-09-11 (23 Nopalito stale-
//      price incident; needs a LIVE connectMLS read no cloud cron can do).
//      An empty day here is a real, disclosed gap, not fabricated content.
//   3. For owner='rust': checks zernio_accounts for owner='rust' — there
//      are none today (docs/PIPELINE.md), so this is reported once as
//      "not wired", no per-day noise.
//   4. Pipeline B (video_library) inventory: counts status='heath_approved'
//      AND quality_status='passed' rows (api/_lib/verify-video-quality.js's
//      gateBeforePublish() gate — a row that hasn't passed can never count
//      as "ready", same rule the publish-time gate itself enforces) against
//      the 7 platform-days ahead, so the report can say "have N ready,
//      need ~7" rather than just a raw approved count.
//
// CAP ENFORCEMENT: this cron never assigns scheduled_for and never calls
// Zernio directly — it only ensures DRAFT content exists. Actual pacing
// (posting_schedule.max_per_day, per-owner caps fixed in cron-post-videos.js
// 2026-09-15) still happens exactly where it already did: scheduling.js's
// assignNextScheduledFor() at approval time, and cron-publish-approved.js /
// cron-post-videos.js at publish time. Nothing here can bypass those caps
// because nothing here posts anything.
//
// IDEMPOTENT BY CONSTRUCTION: re-running this same day is a no-op for every
// date that already has rows (checked before any generation call), and the
// downstream generator itself upserts on post_id (date-keyed) — running
// twice can never produce a duplicate Zernio post, because nothing here
// posts to Zernio at all.
//
// Auth: Authorization: Bearer ${CRON_SECRET} OR x-vercel-cron header.
// Schedule: vercel.json — 0 9 * * 1 (Monday ~4am CDT, ahead of the 11:00
// UTC daily generation run).
//
// Owner: Carter, 2026-09-16

require('./_lib/telegram-gate').install('cron-weekly-content-scheduler');

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SELF_BASE_URL = process.env.SELF_BASE_URL || 'https://meetdossie.com';

const DAYS_AHEAD = 7;

// Owners with an actual automated generator vs. those where an empty day is
// a real, structural gap this cron reports rather than fabricates a fix
// for. Keep in sync with social_posts_target_owner_check /
// zernio_accounts_owner_check (both currently only allow dossie/heath-realtor
// — 'rust' has zero Zernio wiring, checked live below, not assumed).
const OWNERS_WITH_AUTOMATED_GENERATOR = new Set(['dossie']);
const KNOWN_OWNERS = ['dossie', 'heath-realtor'];

async function supabaseFetch(path, init = {}) {
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

function utcDateStr(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function existingRowCount(owner, dateStr) {
  const dayStart = `${dateStr}T00:00:00.000Z`;
  const dayEnd = `${dateStr}T23:59:59.999Z`;
  const res = await supabaseFetch(
    `/rest/v1/social_posts?target_owner=eq.${encodeURIComponent(owner)}`
    + `&generated_at=gte.${encodeURIComponent(dayStart)}&generated_at=lte.${encodeURIComponent(dayEnd)}`
    + '&select=platform,status',
  );
  if (!res.ok || !Array.isArray(res.data)) return null; // null = query failed, distinct from 0 = genuinely empty
  return res.data;
}

async function callAdvanceGenerate(dateStr) {
  if (!CRON_SECRET) return { ok: false, error: 'CRON_SECRET not configured — cannot call cron-generate-posts internally' };
  try {
    const res = await fetch(`${SELF_BASE_URL}/api/cron-generate-posts?target_date=${encodeURIComponent(dateStr)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) return { ok: false, status: res.status, error: (data && data.error) || text.slice(0, 300) };
    return { ok: true, inserted: data ? data.inserted : null, generated: data ? data.generated : null };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

async function rustWiredCheck() {
  const res = await supabaseFetch("/rest/v1/zernio_accounts?owner=eq.rust&is_active=eq.true&select=id&limit=1");
  if (!res.ok || !Array.isArray(res.data)) return { wired: false, checkFailed: true };
  return { wired: res.data.length > 0, checkFailed: false };
}

async function videoInventory() {
  const res = await supabaseFetch(
    "/rest/v1/video_library?status=eq.heath_approved&quality_status=eq.passed&select=id,target_owner",
  );
  if (!res.ok || !Array.isArray(res.data)) return { ready: null };
  return { ready: res.data.length };
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false, reason: 'telegram not configured' };
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  return { ok: res.ok, status: res.status };
}

/**
 * Core routine, exported separately from the HTTP handler so regressions
 * can call it directly without spinning up req/res mocks.
 */
async function runWeeklyScheduler({ dryRun = false } = {}) {
  const dates = Array.from({ length: DAYS_AHEAD }, (_, i) => utcDateStr(i));
  const perOwner = {};

  for (const owner of KNOWN_OWNERS) {
    const days = [];
    for (const dateStr of dates) {
      const rows = await existingRowCount(owner, dateStr);
      if (rows === null) {
        days.push({ date: dateStr, filled: null, reason: 'existing-supply query failed — skipped, not counted as empty' });
        continue;
      }
      if (rows.length > 0) {
        days.push({ date: dateStr, filled: rows.length, action: 'already_filled', platforms: rows.map((r) => r.platform) });
        continue;
      }
      // Nothing exists for this day yet.
      if (!OWNERS_WITH_AUTOMATED_GENERATOR.has(owner)) {
        days.push({
          date: dateStr,
          filled: 0,
          action: 'gap_no_generator',
          reason: owner === 'heath-realtor'
            ? 'cron-daily-listing-posts.js disabled on serverless since 2026-09-11 (stale-price incident) — needs a live connectMLS read; run scripts/listing-marketing-generate-live.js locally'
            : 'no automated generator wired for this owner',
        });
        continue;
      }
      if (dryRun) {
        days.push({ date: dateStr, filled: 0, action: 'would_generate_dry_run' });
        continue;
      }
      const genResult = await callAdvanceGenerate(dateStr);
      days.push({
        date: dateStr,
        filled: genResult.ok ? (genResult.inserted || 0) : 0,
        action: genResult.ok ? 'generated' : 'generate_failed',
        error: genResult.ok ? null : genResult.error,
      });
    }
    perOwner[owner] = days;
  }

  const rust = await rustWiredCheck();
  const video = await videoInventory();

  return { dates, perOwner, rust, video };
}

function formatReport({ dates, perOwner, rust, video }) {
  const lines = [`WEEKLY CONTENT SCHEDULER — ${dates[0]} to ${dates[dates.length - 1]}`, ''];

  for (const owner of Object.keys(perOwner)) {
    const days = perOwner[owner];
    const filledDays = days.filter((d) => d.filled > 0).length;
    const generatedDays = days.filter((d) => d.action === 'generated').length;
    const gapDays = days.filter((d) => d.action === 'gap_no_generator').length;
    const failedDays = days.filter((d) => d.action === 'generate_failed').length;
    lines.push(`${owner}: ${filledDays}/${days.length} day(s) have content (${generatedDays} generated this run, ${gapDays} gap-no-generator, ${failedDays} generate-failed).`);
    for (const d of days) {
      if (d.action === 'already_filled') continue; // healthy + boring — skip in the summary, still in the JSON body
      const detail = d.reason || d.error || '';
      lines.push(`  ${d.date}: ${d.action}${detail ? ` — ${detail}` : ''}`);
    }
  }

  lines.push('', `rust: ${rust.checkFailed ? 'zernio_accounts check failed' : (rust.wired ? 'wired — not yet handled by this scheduler' : 'not wired (no zernio_accounts row) — skipped')}`);
  lines.push(`video (Pipeline B) ready-to-post inventory: ${video.ready === null ? 'query failed' : video.ready}`);

  return lines.join('\n');
}

module.exports = withTelemetry('cron-weekly-content-scheduler', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const dryRun = req.query && req.query.dry_run === '1';
  const result = await runWeeklyScheduler({ dryRun });
  const text = formatReport(result);

  let telegram = { ok: false, reason: 'dry_run' };
  if (!dryRun) {
    telegram = await sendTelegram(text);
  }

  return res.status(200).json({
    ok: true,
    ...result,
    telegram_sent: !!telegram.ok,
    dry_run: !!dryRun,
    preview: dryRun ? text : undefined,
  });
});

module.exports.runWeeklyScheduler = runWeeklyScheduler;
module.exports.formatReport = formatReport;
module.exports.existingRowCount = existingRowCount;
