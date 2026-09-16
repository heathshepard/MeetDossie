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
const { listGoalSetKeys, getGoalSet } = require('./_lib/social-goals.js');
const { computeGoalProgress, formatGoalProgressLines } = require('./_lib/social-goals-progress.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SELF_BASE_URL = process.env.SELF_BASE_URL || 'https://meetdossie.com';

const DAYS_AHEAD = 7;

// Must match cron-generate-posts.js POST_PLAN_BASE's fixed facebook slot
// count (currently 2: CAPABILITY_ONELINER + FOUNDER_STORY) — the organic
// baseline every empty day already produces without any goal-pacing help.
// Cross-checked against the real plan by
// scripts/regression-social-goals-pacing.js so drift there is caught, not
// silently wrong (this file does not require cron-generate-posts.js at
// runtime — that module installs its own telegram-gate patch on require,
// and double-installing it in the same lambda is an avoidable risk for a
// value we can just keep in sync via a cross-check test instead).
const ASSUMED_ORGANIC_FACEBOOK_POSTS_PER_DAY = 2;

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

async function callAdvanceGenerate(dateStr, { extraFacebookPosts = 0 } = {}) {
  if (!CRON_SECRET) return { ok: false, error: 'CRON_SECRET not configured — cannot call cron-generate-posts internally' };
  try {
    let url = `${SELF_BASE_URL}/api/cron-generate-posts?target_date=${encodeURIComponent(dateStr)}`;
    if (extraFacebookPosts > 0) url += `&extra_facebook_posts=${encodeURIComponent(extraFacebookPosts)}`;
    const res = await fetch(url, {
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

// Goal-pacing extra-slot planning (Carter, 2026-09-16 — Facebook Professional
// Dashboard targets, api/_lib/social-goals.js). Only acts on public_posts —
// public_posts_with_photos has no automated route under the current
// video-only-no-static-cards policy (cron-generate-posts.js's
// card_fallback_removed), so it is reported, never "fixed" by generating a
// text post that can't satisfy it. Spreads the SAME extra count evenly
// across every currently-empty day in the scheduling window — simple,
// respects the configured per-day ceiling, never touches a day that
// already has content (idempotency is unaffected: this only changes WHAT
// gets requested for an empty day, never whether one gets requested).
function planExtraFacebookSlots({ emptyDates, progress }) {
  if (!progress || emptyDates.length === 0) return { perDay: 0, plan: {} };
  const postsPacing = progress.targets.public_posts;
  const perDayCeiling = (progress.scheduler && progress.scheduler.max_extra_public_posts_per_day) || 0;
  if (perDayCeiling <= 0) return { perDay: 0, plan: {} };
  if (['met', 'period_ended_met', 'period_ended_missed'].includes(postsPacing.paceStatus)) return { perDay: 0, plan: {} };

  const extraPerDayNeeded = Math.max(0, Math.ceil(postsPacing.perDayNeeded) - ASSUMED_ORGANIC_FACEBOOK_POSTS_PER_DAY);
  if (extraPerDayNeeded <= 0) return { perDay: 0, plan: {} };

  const perDay = Math.min(extraPerDayNeeded, perDayCeiling);
  const plan = {};
  for (const dateStr of emptyDates) plan[dateStr] = perDay;
  return { perDay, plan };
}

function goalSetsForOwner(owner) {
  return listGoalSetKeys()
    .map((key) => ({ key, goalSet: getGoalSet(key) }))
    .filter(({ goalSet }) => goalSet && goalSet.target_owner === owner);
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
  const goalProgress = {};

  for (const owner of KNOWN_OWNERS) {
    // Pass 1: existing-supply lookup for every date, up front — needed
    // before goal-pacing can decide how to spread extra slots across the
    // days that actually need filling.
    const existingByDate = {};
    for (const dateStr of dates) existingByDate[dateStr] = await existingRowCount(owner, dateStr);
    const emptyDates = dates.filter((d) => Array.isArray(existingByDate[d]) && existingByDate[d].length === 0);

    // Goal-aware extra-slot plan (owner-scoped — only applies to goal sets
    // configured for THIS owner; today that's just dossie_fb_page).
    let extraPlan = { perDay: 0, plan: {} };
    if (OWNERS_WITH_AUTOMATED_GENERATOR.has(owner)) {
      const ownerGoalSets = goalSetsForOwner(owner);
      for (const { key } of ownerGoalSets) {
        const progress = await computeGoalProgress(key);
        goalProgress[key] = progress;
        if (progress && !progress.period_expired) {
          const thisPlan = planExtraFacebookSlots({ emptyDates, progress });
          // Multiple goal sets for the same owner would stack here — none
          // exist yet, so this is a straight assign, not a merge, kept
          // simple until a second facebook-targeting goal set for the same
          // owner actually exists.
          if (thisPlan.perDay > 0) extraPlan = thisPlan;
        }
      }
    }

    // Pass 2: act on each date using the pre-computed existing-supply +
    // extra-slot plan.
    const days = [];
    for (const dateStr of dates) {
      const rows = existingByDate[dateStr];
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
      const extraFacebookPosts = extraPlan.plan[dateStr] || 0;
      if (dryRun) {
        days.push({ date: dateStr, filled: 0, action: 'would_generate_dry_run', extra_facebook_posts_planned: extraFacebookPosts });
        continue;
      }
      const genResult = await callAdvanceGenerate(dateStr, { extraFacebookPosts });
      days.push({
        date: dateStr,
        filled: genResult.ok ? (genResult.inserted || 0) : 0,
        action: genResult.ok ? 'generated' : 'generate_failed',
        extra_facebook_posts_requested: extraFacebookPosts,
        error: genResult.ok ? null : genResult.error,
      });
    }
    perOwner[owner] = days;
  }

  const rust = await rustWiredCheck();
  const video = await videoInventory();

  return { dates, perOwner, rust, video, goalProgress };
}

function formatReport({ dates, perOwner, rust, video, goalProgress }) {
  const lines = [`WEEKLY CONTENT SCHEDULER — ${dates[0]} to ${dates[dates.length - 1]}`, ''];

  for (const owner of Object.keys(perOwner)) {
    const days = perOwner[owner];
    const filledDays = days.filter((d) => d.filled > 0).length;
    const generatedDays = days.filter((d) => d.action === 'generated').length;
    const gapDays = days.filter((d) => d.action === 'gap_no_generator').length;
    const failedDays = days.filter((d) => d.action === 'generate_failed').length;
    const extraRequested = days.reduce((sum, d) => sum + (d.extra_facebook_posts_requested || 0), 0);
    lines.push(`${owner}: ${filledDays}/${days.length} day(s) have content (${generatedDays} generated this run, ${gapDays} gap-no-generator, ${failedDays} generate-failed${extraRequested > 0 ? `, ${extraRequested} extra goal-pacing facebook post(s) requested` : ''}).`);
    for (const d of days) {
      if (d.action === 'already_filled') continue; // healthy + boring — skip in the summary, still in the JSON body
      const detail = d.reason || d.error || '';
      const extraNote = d.extra_facebook_posts_requested ? ` (+${d.extra_facebook_posts_requested} goal-pacing facebook)` : '';
      lines.push(`  ${d.date}: ${d.action}${detail ? ` — ${detail}` : ''}${extraNote}`);
    }
  }

  lines.push('', `rust: ${rust.checkFailed ? 'zernio_accounts check failed' : (rust.wired ? 'wired — not yet handled by this scheduler' : 'not wired (no zernio_accounts row) — skipped')}`);
  lines.push(`video (Pipeline B) ready-to-post inventory: ${video.ready === null ? 'query failed' : video.ready}`);

  const goalKeys = Object.keys(goalProgress || {});
  if (goalKeys.length > 0) {
    lines.push('');
    for (const key of goalKeys) {
      const progress = goalProgress[key];
      if (!progress) { lines.push(`GOALS (${key}): could not compute progress this run.`); continue; }
      lines.push(...formatGoalProgressLines(progress));
      // group_posts is a separate quota this cron never touches — surface
      // unreachability explicitly here too, not just in the daily heartbeat,
      // since this IS the weekly planning moment Heath would act on it.
      if (progress.targets.group_posts.reachable === false) {
        lines.push(`  ⚠ group_posts target is UNREACHABLE this period at the current cap — flagging now rather than under-delivering quietly.`);
      }
    }
  }

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
module.exports.planExtraFacebookSlots = planExtraFacebookSlots;
module.exports.ASSUMED_ORGANIC_FACEBOOK_POSTS_PER_DAY = ASSUMED_ORGANIC_FACEBOOK_POSTS_PER_DAY;
