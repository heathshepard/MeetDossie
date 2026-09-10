'use strict';

// Vercel Serverless Function: /api/cron-daily-listing-posts
//
// Daily driver for Heath's own active-listing marketing rotation
// (Fawndale / Nopalito / Senisa). Runs the generator
// (scripts/listing-marketing-generator.js's run()) which:
//   - drafts ONE Tier-1 owned-channel post (social_posts, target_owner=
//     'heath-realtor') -- picked up automatically by the EXISTING
//     cron-send-for-approval -> Telegram -> cron-publish-approved chain,
//     no separate notify needed here.
//   - drafts + Telegram-notifies ONE Tier-2 FB-group post (group_posts,
//     pipeline='listing-groups') -- lst_approve/lst_edit/lst_skip buttons,
//     api/listing-group-post-callback.js.
//
// Does NOT run scripts/listing-marketing-status-sync.js itself (that needs
// a real connectMLS browser session, which this serverless function can't
// reach) -- status-sync must run locally first (same "serverless can't
// reach Playwright/Chrome" split as cron-daily-group5-posts.js /
// fb-group5-post-queue.js). If listing_marketing_status is stale or empty,
// this cron safely no-ops (0 active listings found) rather than guessing.
//
// STAGING-ONLY as of 2026-09-10 -- NOT yet added to vercel.json's crons
// array. Heath approves the first manually-triggered cycle before this
// runs on an actual schedule.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}  (manual) OR
//           x-vercel-cron header (Vercel cron, once enabled)
//
// Owner: Carter, 2026-09-10

const telegramGate = require('./_lib/telegram-gate');
telegramGate.install('cron-daily-listing-posts');

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { run: runListingGenerator } = require('../scripts/listing-marketing-generator');

const CRON_SECRET = process.env.CRON_SECRET;

module.exports = withTelemetry('cron-daily-listing-posts', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const missing = [];
  if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    return res.status(500).json({ ok: false, error: `Missing env: ${missing.join(', ')}` });
  }

  try {
    const result = await runListingGenerator();
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron-daily-listing-posts] Fatal:', err && err.message);
    return res.status(500).json({ ok: false, error: err && err.message });
  }
});
