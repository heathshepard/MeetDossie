'use strict';

// Vercel Serverless Function: /api/cron-retry-unsent-approvals
//
// THE GAP THIS CLOSES (Carter, 2026-09-12, Heath-approved): a group_posts
// draft whose Telegram approval-card send failed (or was never attempted --
// a crashed run, a transient network error) was left at status='draft',
// telegram_sent_at=null FOREVER. Nothing in the codebase re-attempted it.
// Confirmed 3 real stranded rows (pipeline='listing-groups': Windcrest,
// Tx Hill Country BST, Buy Buy Boerne) sitting since 2026-09-11 16:37 UTC
// with zero retry attempts logged anywhere -- Heath approved these
// conceptually and never even saw the approval card.
//
// This cron runs every 30 minutes and re-attempts delivery for ANY draft
// row (across both known group_posts pipelines) whose telegram_sent_at is
// still null and is older than 30 minutes, bounded at 3 attempts total
// (api/_lib/telegram-send-retry.js). The 3rd failed attempt fires a named,
// loud alert to Heath ("could not deliver X for approval") instead of
// silently retrying forever or silently giving up.
//
//   - pipeline='daily5'         -> api/_lib/daily-group5-post-generator.js's
//                                  retryPendingNotifications() (existing,
//                                  now bounded+logged as of this change).
//   - pipeline='listing-groups' -> scripts/listing-marketing-generator.js's
//                                  retryPendingListingGroupNotifications()
//                                  (new as of this change -- this pipeline
//                                  had ZERO retry path before).
//
// social_posts gets the same bounded-attempt + log + final-alert treatment
// directly inside api/cron-send-for-approval.js (that cron already re-scans
// every unsent draft on every run and owns the correct message-building/
// scoring logic for that table) -- see that file's own header for the
// 2026-09-12 changes. This route does NOT touch social_posts.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}  (manual) OR
//           x-vercel-cron header (Vercel cron)
// Schedule: vercel.json — */30 * * * * (every 30 minutes)
//
// Owner: Carter, 2026-09-12

const telegramGate = require('./_lib/telegram-gate');
telegramGate.install('cron-retry-unsent-approvals');

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { retryPendingNotifications } = require('./_lib/daily-group5-post-generator');
const { retryPendingListingGroupNotifications } = require('../scripts/listing-marketing-generator');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = withTelemetry('cron-retry-unsent-approvals', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_MARKETING_BOT_TOKEN');
  if (!TELEGRAM_CHAT_ID) missing.push('TELEGRAM_CHAT_ID');
  if (missing.length) {
    return res.status(500).json({ ok: false, error: `Missing env: ${missing.join(', ')}` });
  }

  try {
    const daily5 = await retryPendingNotifications({
      supabaseUrl: SUPABASE_URL,
      supabaseKey: SUPABASE_SERVICE_ROLE_KEY,
      telegramToken: TELEGRAM_BOT_TOKEN,
      telegramChatId: TELEGRAM_CHAT_ID,
    });

    const listingGroups = await retryPendingListingGroupNotifications({
      telegramToken: TELEGRAM_BOT_TOKEN,
      telegramChatId: TELEGRAM_CHAT_ID,
    });

    return res.status(200).json({
      ok: true,
      daily5,
      listingGroups,
    });
  } catch (err) {
    console.error('[cron-retry-unsent-approvals] FATAL', err && err.message);
    return res.status(500).json({ ok: false, error: err && err.message });
  }
});
