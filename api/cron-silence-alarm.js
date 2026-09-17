'use strict';

// Vercel Serverless Function: /api/cron-silence-alarm
//
// THE GAP THIS CLOSES (Heath, 2026-09-12): three separate silent failures
// hit him this week and nobody noticed until he said something — a missing
// column 400ing every group_posts approve tap for 3 months, a uuid-column
// bug 400ing every social_posts approve tap ever, and failed sends that
// left rows stranded with no retry. On top of that: Instagram (dossie brand
// account) hadn't posted in 18 days and TikTok has essentially never
// posted, both invisible until Heath checked manually.
//
// EXTENDED 2026-09-16 (Heath's top priority: consistent posting) from
// "alarm only, silent when healthy" to a DAILY HEARTBEAT — one Telegram
// message every morning regardless of whether anything's wrong, so the
// pipeline's actual state is never something Heath has to go check for
// himself. The alarm half is unchanged (still dedup'd via alert_state, still
// fires loud); the heartbeat half is new and always shown:
//   - posted last 24h, per platform+brand
//   - scheduled next 7 days, per platform+brand
//   - stuck items (approved-unposted, pending_video, failed, pending admin
//     approval, video quality_hold/failed)
//   - comments awaiting reply (TC-discovery + organic social)
//   - per-tracked-pair last-posted status (healthy pairs shown too, not
//     just silent ones)
//   - a static vercel.json cron sanity scan (api/_lib/cron-sanity.js) — the
//     exact "0 0 1 1 *"-style trick that hid the 2026-07 content-engine
//     shutdown for weeks, plus any cron pointing at a deleted handler file.
//   - (2026-09-17) CONVERSION ATTRIBUTION — per brand, last 7d/30d: clicks,
//     signups, paid, top/bottom performing content, joined via
//     api/_lib/attribution.js on the content_tag stamped at publish time
//     (api/_lib/content-tag.js). Rust is explicitly reported as
//     not-available (separate Supabase project) rather than a fake zero.
//
// This cron checks, once a day (ALARM half, dedup'd):
//   1. Platform silence — no successful post on a (platform, owner) pair in
//      N days (default 3).
//   2. Approvals sitting >48h without publishing.
//   3. Drafts sitting >24h that were never even sent to Telegram.
//   4. A status accumulating rows without moving (the video_failed/
//      pending_video pattern), including video_library rows stuck at
//      pending_heath_review — already sent to Telegram, never tapped.
//   5. (2026-09-15) TC-discovery/group-post HOST COMMENT HARVEST gone
//      silent — a group_posts row still in its 48h hot window with no
//      harvest in >24h (scripts/harvest-tc-discovery-responses.js's
//      Task Scheduler task not actually running).
//   6. (2026-09-15) SCOPE GAP — a posted group_posts row that's never been
//      harvested at all, either because it fell outside the harvester's
//      scan (the real 2026-09-15 bug) or because fb-group-poster.js never
//      captured a real post permalink for it.
//   7. (2026-09-16) Comments notified/drafted >24h with no decision.
//   8. (2026-09-16) vercel.json cron sanity issues.
//
// Dedup: api/_lib/silence-alarm.js's alert_state table — each ALARM
// condition alerts once per ~20h regardless of how often this cron runs.
// The heartbeat section is NEVER dedup'd — it's a fresh snapshot every run.
//
// Auth: Authorization: Bearer ${CRON_SECRET} OR x-vercel-cron header.
// Schedule: vercel.json — 0 15 * * * (10am CDT daily)
// includeFiles: vercel.json's functions block gives this route
// {vercel.json,api/**/*.js} so api/_lib/cron-sanity.js can read the cron
// config + check handler files exist at runtime (same pattern as
// api/cron-codebase-facts-indexer.js).
//
// Owner: Carter, 2026-09-12 (heartbeat extension 2026-09-16)

require('./_lib/telegram-gate').install('cron-silence-alarm');

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { runAllChecks, buildHeartbeatSnapshot } = require('./_lib/silence-alarm.js');
const { formatGoalProgressLines } = require('./_lib/social-goals-progress.js');

const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false, reason: 'telegram not configured' };
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  return { ok: res.ok, status: res.status };
}

function fmtPlatformOwnerList(list) {
  if (!Array.isArray(list) || list.length === 0) return '(none)';
  return list.map((r) => `${r.platform}${r.target_owner !== 'dossie' ? ` (${r.target_owner})` : ''}: ${r.count}`).join(', ');
}

// CONVERSION ATTRIBUTION section (Carter, 2026-09-17): closes "which post
// produced a signup" — clicks -> signup -> paid, per brand, 7d and 30d. See
// api/_lib/attribution.js for the join logic and BRAND COVERAGE notes (Rust
// runs on a separate Supabase project and is reported as not-available,
// never as a fabricated zero).
function fmtWindow(label, summary) {
  const lines = [`  ${label}: ${summary.totals.paid_total} paid (${summary.totals.paid_attributed} attributed, ` +
    `${summary.totals.paid_unattributed} unattributed) | ${summary.totals.signups_total} signup(s) ` +
    `(${summary.totals.signups_unattributed} unattributed) | clicks: ${summary.clicks_tracking}`];
  for (const brand of Object.keys(summary.per_brand)) {
    const b = summary.per_brand[brand];
    const clicks = b.clicks === null ? `error (${b.clicks_tracking_error})` : b.clicks;
    lines.push(`    ${brand}: ${b.published_count} tagged post(s), ${clicks} clicks, ${b.signups} signup(s), ${b.paid} paid`);
  }
  return lines;
}

function fmtContentRow(c) {
  const clicks = c.clicks == null ? '?' : c.clicks;
  const linkNote = c.no_clickable_link ? ' [no clickable link on this platform]' : '';
  const hook = c.hook_type ? ` hook=${c.hook_type}` : '';
  return `    ${c.content_tag}: ${clicks} clicks, ${c.signups} signup(s), ${c.paid} paid${hook}${linkNote}`;
}

function formatAttributionLines(attribution) {
  const lines = ['', 'CONVERSION ATTRIBUTION (which post produced a signup/paid customer):'];
  if (!attribution || attribution.error) {
    lines.push(`  could not compute this run${attribution && attribution.error ? ` — ${attribution.error}` : ''}.`);
    return lines;
  }
  const { last_7d, last_30d } = attribution;
  lines.push(...fmtWindow('Last 7d', last_7d));
  lines.push(...fmtWindow('Last 30d', last_30d));

  if (last_30d.top_content.length) {
    lines.push('  Top content (30d):');
    for (const c of last_30d.top_content.slice(0, 3)) lines.push(fmtContentRow(c));
  }
  if (last_30d.bottom_content.length) {
    lines.push('  Bottom content (30d):');
    for (const c of last_30d.bottom_content.slice(0, 3)) lines.push(fmtContentRow(c));
  }
  lines.push(`  ${last_30d.platform_caveat}`);
  lines.push(`  rust: ${last_30d.rust.reason}`);
  return lines;
}

function formatHeartbeatMessage(snapshot, fired, suppressed) {
  const lines = [`DOSSIE MORNING HEARTBEAT — ${new Date().toISOString().slice(0, 10)}`, ''];

  lines.push('POSTED last 24h:');
  lines.push(`  ${fmtPlatformOwnerList(snapshot.posted_last_24h.by_platform_owner)}`);
  lines.push(`  FB groups: ${snapshot.posted_last_24h.group_posts ?? 'unknown'}`);

  lines.push('', 'SCHEDULED next 7 days:');
  lines.push(`  ${fmtPlatformOwnerList(snapshot.scheduled_next_7d.by_platform_owner)}`);
  lines.push(`  unscheduled drafts: ${snapshot.scheduled_next_7d.unscheduled_drafts ?? 'unknown'}   video ready-to-post: ${snapshot.scheduled_next_7d.video_ready_to_post ?? 'unknown'}`);

  lines.push('', 'STUCK:');
  const s = snapshot.stuck;
  lines.push(`  approved-unposted: ${s.approved_unposted ?? '?'}   pending_video: ${s.pending_video ?? '?'}   failed(7d): ${s.failed_last_7d ?? '?'}   pending admin approval: ${s.pending_admin_approval ?? '?'}   video quality_hold: ${s.video_quality_hold ?? '?'}   video failed: ${s.video_failed ?? '?'}`);

  lines.push('', 'COMMENTS awaiting reply:');
  lines.push(`  TC-discovery notified: ${snapshot.comments_awaiting_reply.tc_discovery_notified ?? '?'}   drafted (organic): ${snapshot.comments_awaiting_reply.social_draft ?? '?'}`);

  lines.push('', 'PLATFORM STATUS:');
  for (const p of snapshot.platform_status) {
    const label = `${p.platform}${p.target_owner !== 'dossie' ? ` (${p.target_owner})` : ''}`;
    const status = p.last_posted_at
      ? `${p.days_silent}d since last post`
      : 'never posted';
    lines.push(`  ${label}: ${status}`);
  }

  const goalKeys = Object.keys(snapshot.goal_progress || {});
  for (const key of goalKeys) {
    const progress = snapshot.goal_progress[key];
    lines.push('');
    if (!progress || progress.error) {
      lines.push(`GOALS (${key}): could not compute progress this run${progress && progress.error ? ` — ${progress.error}` : ''}.`);
      continue;
    }
    lines.push(...formatGoalProgressLines(progress));
    if (progress.targets.group_posts.reachable === false) {
      lines.push('  ⚠ group_posts target is UNREACHABLE this period at the current cap.');
    }
  }

  lines.push(...formatAttributionLines(snapshot.attribution));

  if (snapshot.cron_sanity.ok) {
    lines.push('', `CRON SANITY: ${snapshot.cron_sanity.totalCrons} crons scanned, ${snapshot.cron_sanity.issues.length} issue(s)`);
    for (const issue of snapshot.cron_sanity.issues) {
      lines.push(`  - ${issue.path} (${issue.schedule}): ${issue.detail}`);
    }
  } else {
    lines.push('', `CRON SANITY: scan failed — ${snapshot.cron_sanity.error}`);
  }

  if (fired.length > 0) {
    lines.push('', `⚠ ALARM — ${fired.length} condition(s):`);
    for (const c of fired) lines.push(`  - ${c.message}`);
    if (suppressed.length) {
      lines.push(`  (${suppressed.length} more condition(s) still true but already alerted today — not re-sent)`);
    }
  } else if (suppressed.length > 0) {
    lines.push('', `(${suppressed.length} alarm condition(s) still true, already alerted — not re-sent)`);
  } else {
    lines.push('', 'ALARM: all clear.');
  }

  return lines.join('\n');
}

module.exports = withTelemetry('cron-silence-alarm', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const dryRun = req.query && req.query.dry_run === '1';
  const [{ fired, suppressed, totalConditions }, snapshot] = await Promise.all([
    runAllChecks({ dryRun }),
    buildHeartbeatSnapshot(),
  ]);

  const text = formatHeartbeatMessage(snapshot, fired, suppressed);

  let telegram = { ok: false, reason: 'dry_run' };
  if (!dryRun) {
    telegram = await sendTelegram(text);
  }

  return res.status(200).json({
    ok: true,
    fired: fired.length,
    suppressed: suppressed.length,
    total_conditions: totalConditions,
    conditions: fired.map((c) => c.key),
    heartbeat: snapshot,
    telegram_sent: !!telegram.ok,
    dry_run: !!dryRun,
    preview: dryRun ? text : undefined,
  });
});
