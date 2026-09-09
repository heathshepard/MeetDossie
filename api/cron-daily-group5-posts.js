'use strict';

// Vercel Serverless Function: /api/cron-daily-group5-posts
//
// Part 1 (generate -> draft -> notify) of the daily 5-group-post pipeline.
// Heath's decision 2026-09-09, verbatim: "people can post more than once a
// day. 5 groups 1 post to each group per day is fine" — drafts the NEXT
// day's post for EACH of the 5 groups in scripts/comment-hunt-groups.json
// and sends every one to Heath via DossieMarketingBot for Approve/Edit/Skip
// (gp5_* callbacks in api/group5-post-callback.js + api/telegram-webhook.js).
//
// Runs overnight so all 5 drafts are waiting for Heath before the posting
// window opens. Also retries Telegram notification for any prior-run rows
// that never got delivered (suppressed / transient failure) — never
// re-generates content, so a retry never re-bills Claude.
//
// The actual Facebook post happens LOCALLY via scripts/fb-group-poster.js,
// driven by scripts/fb-group5-post-queue.js on the existing "Dossie TC
// Discovery Harvest" Windows Task Scheduler tick (serverless can't reach
// the Playwright/Chrome session). Budget: comment-caps.js
// 'facebook_group_post', 5/day, 18-24 min varied spacing. NOTHING posts
// without status='approved', which only Heath's explicit tap/edit can set.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}  (manual) OR
//           x-vercel-cron header (Vercel cron)
// Schedule: vercel.json — 0 9 * * *  (9 UTC = 4 AM CST, well before the
//           posting window so approvals can happen over morning coffee).
//
// Owner: Carter, 2026-09-09

const telegramGate = require('./_lib/telegram-gate');
telegramGate.install('cron-daily-group5-posts');

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { runDailyGroup5PostGeneration, retryPendingNotifications } = require('./_lib/daily-group5-post-generator');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = withTelemetry('cron-daily-group5-posts', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_MARKETING_BOT_TOKEN');
  if (!TELEGRAM_CHAT_ID) missing.push('TELEGRAM_CHAT_ID');
  if (missing.length) {
    return res.status(500).json({ ok: false, error: `Missing env: ${missing.join(', ')}` });
  }

  try {
    const retry = await retryPendingNotifications({
      supabaseUrl: SUPABASE_URL,
      supabaseKey: SUPABASE_SERVICE_ROLE_KEY,
      telegramToken: TELEGRAM_BOT_TOKEN,
      telegramChatId: TELEGRAM_CHAT_ID,
    });

    const result = await runDailyGroup5PostGeneration({
      supabaseUrl: SUPABASE_URL,
      supabaseKey: SUPABASE_SERVICE_ROLE_KEY,
      anthropicKey: ANTHROPIC_API_KEY,
      telegramToken: TELEGRAM_BOT_TOKEN,
      telegramChatId: TELEGRAM_CHAT_ID,
    });

    return res.status(200).json({
      ok: true,
      retry,
      drafted: result.drafted,
      skipped: result.skipped,
      notified: result.notified,
      results: result.results,
    });
  } catch (err) {
    console.error('[cron-daily-group5-posts] Fatal:', err && err.message);
    return res.status(500).json({ ok: false, error: err && err.message });
  }
});
