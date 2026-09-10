'use strict';

// api/cron-monday-digest-1300.js
// Consolidated dispatcher — both crons below already ran at 0 13 * * 1
// (Monday 13:00 UTC) as separate Vercel cron entries. Freed for the
// vercel.json 100-cron cap on 2026-09-10; each handler is untouched, still
// reachable directly, and still auth-gated the same way. See
// api/_lib/fanout-cron.js for what "dispatcher" means here.
//
// Was: /api/cron-weekly-team-risk-digest, /api/cron-weekly-boost-alert
// Auth: Authorization: Bearer ${CRON_SECRET} (or Vercel's own cron header)

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { fanout, isAuthorizedCronCaller } = require('./_lib/fanout-cron.js');

module.exports = withTelemetry('cron-monday-digest-1300', async function handler(req, res) {
  if (!isAuthorizedCronCaller(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const results = await fanout([
    '/api/cron-weekly-team-risk-digest',
    '/api/cron-weekly-boost-alert',
  ]);

  const allOk = results.every((r) => r.ok);
  return res.status(allOk ? 200 : 207).json({ ok: allOk, results });
});
