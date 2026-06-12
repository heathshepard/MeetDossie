const { withTelemetry } = require('./_lib/cron-telemetry.js');

'use strict';

// Vercel Serverless Function: /api/cron-daily-fb-posts
// Daily FB group post generation. Picks the 4 groups with the oldest
// last_posted_at that have passed their cool-down, calls Haiku to draft
// fresh copy from the category-matched template, inserts each as a
// group_posts row with status='draft', and sends the DossieMarketingBot
// approval pair (preview message + buttons message) to Heath.
//
// Heath taps Approve in Telegram → group-post-callback.js flips the row to
// status='approved'. Then the local fb-group-poster.js script (Playwright,
// DossieBot Chrome profile) is run with --post-id to actually post.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}  (manual) OR
//           x-vercel-cron header (Vercel cron)
// Schedule: vercel.json — 0 14 * * *  (14 UTC = 9 AM CST late-morning FB peak).
//
// Cap:      MAX_GROUPS_PER_DAY=4 — keeps daily volume sane for review.

const { runGroupPostGeneration } = require('./_lib/group-post-generator');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const MAX_GROUPS_PER_DAY = 4;

module.exports = withTelemetry('cron-daily-fb-posts', async function handler(req, res) {
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
    const result = await runGroupPostGeneration({
      supabaseUrl: SUPABASE_URL,
      supabaseKey: SUPABASE_SERVICE_ROLE_KEY,
      anthropicKey: ANTHROPIC_API_KEY,
      telegramToken: TELEGRAM_BOT_TOKEN,
      telegramChatId: TELEGRAM_CHAT_ID,
      maxPerRun: MAX_GROUPS_PER_DAY,
    });

    return res.status(200).json({
      ok: true,
      processed: result.processed,
      skipped: result.skipped,
      cap: MAX_GROUPS_PER_DAY,
      generated: result.generated.map((g) => ({
        id: g.id,
        group_name: g.group_name,
        template_id: g.template_id,
        pillar: g.pillar,
      })),
    });
  } catch (err) {
    console.error('[cron-daily-fb-posts] Fatal:', err && err.message);
    return res.status(500).json({ ok: false, error: err && err.message });
  }
});
