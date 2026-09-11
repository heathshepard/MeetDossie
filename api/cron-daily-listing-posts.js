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
// reach) -- same "serverless can't reach Playwright/Chrome" split as
// cron-daily-group5-posts.js / fb-group5-post-queue.js.
//
// DISABLED 2026-09-11 after the 23 Nopalito stale-price incident (a
// group_posts draft advertised $1,195,000 against a live MLS price of
// $999,000, sourced from a listing_marketing_status snapshot this route
// would have trusted). Since this route genuinely cannot do a live MLS
// read, and the generator must never draft off a DB snapshot unattended,
// this endpoint now always no-ops. The only supported unattended path is
// scripts/listing-marketing-generate-live.js run locally, which does the
// live connectMLS read and the generation in one process with zero gap.
// Do not re-enable this route without also giving it a real, in-request
// live MLS read -- a shared DB table alone is not sufficient here.
//
// STAGING-ONLY as of 2026-09-10 -- NOT added to vercel.json's crons array.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}  (manual) OR
//           x-vercel-cron header (Vercel cron, once enabled)
//
// Owner: Carter, 2026-09-10

const telegramGate = require('./_lib/telegram-gate');
telegramGate.install('cron-daily-listing-posts');

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const CRON_SECRET = process.env.CRON_SECRET;

module.exports = withTelemetry('cron-daily-listing-posts', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  // Intentionally disabled -- see header comment. This route cannot do a
  // live MLS read, and the listing-marketing generator must never draft
  // off a DB snapshot unattended. Run scripts/listing-marketing-generate-live.js
  // locally instead.
  return res.status(200).json({
    ok: true,
    disabled: true,
    reason: 'This route no-ops as of 2026-09-11 (23 Nopalito stale-price incident) -- no live MLS read is possible from Vercel serverless. Run node scripts/listing-marketing-generate-live.js locally instead.',
    ownedDrafted: 0,
    groupDrafted: 0,
  });
});
