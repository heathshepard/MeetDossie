'use strict';

// api/cron-sync-video-automations.js
// =============================================================================
// Reconciles comment-to-DM automations against the video records, so a keyword
// is never a manual chore.
//
// Runs on a schedule rather than firing on a publish event ON PURPOSE. A
// reconciler self-heals: a missed publish, a failed run, a change made by hand
// in the Zernio UI, a retraction that happened while this was down -- all of
// them converge on the next pass. An event handler would have to be perfect
// once and would leave an orphaned automation DMing people about a pulled
// video forever if it ever wasn't.
//
// Creates NOTHING unless ops_flags.zernio_comment_automations is on, and arms
// nothing unless ops_flags.zernio_comment_automations_live is also on. Both
// default false. See api/_lib/video-comment-automations.js for why it is two
// flags and not one.
//
// ?dryRun=1 forces report-only regardless of flags.
//
// Schedule: 0 */4 * * *. Owner: Atlas, 2026-09-25.
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { syncVideoAutomations } = require('./_lib/video-comment-automations.js');

const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function notify(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch { /* notification is best effort, never fails the sync */ }
}

async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }
  if (!process.env.ZERNIO_API_KEY) {
    return res.status(503).json({ ok: false, error: 'zernio_env_missing' });
  }

  const result = await syncVideoAutomations({
    supabaseUrl: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    dryRun: String(req.query.dryRun || '') === '1',
    onlyVideoId: req.query.videoId || null,
  });

  if (result.error) return res.status(500).json({ ok: false, error: result.error });

  // A keyword collision is a data problem only a human can resolve (two videos
  // claiming one attribution token), and it BLOCKS both of them from arming.
  // Silently planning around it is how it would stay broken.
  if (result.collisions.length) {
    await notify(
      `Comment-to-DM keyword collision - ${result.collisions.length} refused, nothing armed for them:\n`
      + result.collisions.map((c) => `  "${c.keyword}": ${(c.videos || []).join(', ')}`).join('\n')
      + '\nFix: give each video a unique dm_keyword in video_library.',
    );
  }
  if (result.orphans.length) {
    await notify(
      `Comment-to-DM orphan sweep: ${result.orphans.length} automation(s) at Zernio had no ledger row`
      + `${result.dry_run ? ' (reported only, flags are off)' : ' (deleted)'}.`,
    );
  }

  return res.status(200).json({
    ok: true,
    // Telemetry counts these as the outcome. A sync that changes nothing
    // because nothing needed changing is honest zero, not hidden success.
    created: result.counts.applied,
    ...result.counts,
    flags: result.flags,
    dry_run: result.dry_run,
    plan: result.plan.slice(0, 25),
    collisions: result.collisions,
    orphans: result.orphans.slice(0, 10),
    errors: result.errors.slice(0, 5),
  });
}

module.exports = withTelemetry('cron-sync-video-automations', handler);
module.exports.handler = handler;
