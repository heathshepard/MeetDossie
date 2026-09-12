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
// This cron checks, once a day:
//   1. Platform silence — no successful post on a (platform, owner) pair in
//      N days (default 3).
//   2. Approvals sitting >48h without publishing.
//   3. Drafts sitting >24h that were never even sent to Telegram.
//   4. A status accumulating rows without moving (the video_failed/
//      pending_video pattern), including video_library rows stuck at
//      pending_heath_review — already sent to Telegram, never tapped.
//
// Dedup: api/_lib/silence-alarm.js's alert_state table — each condition
// alerts once per ~20h regardless of how often this cron runs.
//
// Auth: Authorization: Bearer ${CRON_SECRET} OR x-vercel-cron header.
// Schedule: vercel.json — 0 15 * * * (10am CDT daily)
//
// Owner: Carter, 2026-09-12

require('./_lib/telegram-gate').install('cron-silence-alarm');

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { runAllChecks } = require('./_lib/silence-alarm.js');

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
  const { fired, suppressed, totalConditions } = await runAllChecks({ dryRun });

  if (fired.length === 0) {
    return res.status(200).json({ ok: true, fired: 0, suppressed: suppressed.length, total_conditions: totalConditions });
  }

  const lines = [`SILENCE ALARM — ${fired.length} condition(s)`, ''];
  for (const c of fired) lines.push(`- ${c.message}`);
  if (suppressed.length) {
    lines.push('', `(${suppressed.length} more condition(s) still true but already alerted today — not re-sent)`);
  }

  let telegram = { ok: false, reason: 'dry_run' };
  if (!dryRun) {
    telegram = await sendTelegram(lines.join('\n'));
  }

  return res.status(200).json({
    ok: true,
    fired: fired.length,
    suppressed: suppressed.length,
    total_conditions: totalConditions,
    conditions: fired.map((c) => c.key),
    telegram_sent: !!telegram.ok,
    dry_run: !!dryRun,
  });
});
