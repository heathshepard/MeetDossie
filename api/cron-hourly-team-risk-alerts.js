// Vercel Serverless Function: /api/cron-hourly-team-risk-alerts
//
// Thin HTTP wrapper around api/_lib/team-risk-alerts-runner.js's
// runHourlyTeamRiskAlerts() — see that file's header for the full design
// (dedup ledger, baseline seeding, risk_key format).
//
// NOT wired into vercel.json's `crons` array — that array is hard-capped at
// 100 items by Vercel and this project was already AT that cap. The actual
// hourly trigger is an in-process call from api/cron-unsubscribe-spike-
// monitor.js's existing hourly schedule slot (see that file). This endpoint
// stays live and independently callable for manual verification / a future
// admin-triggered re-run — same CRON_SECRET pattern as every other cron in
// this repo.
//
// Auth: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-08-23 (SV-ENG-TEAM-RISK-PUSH)

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { runHourlyTeamRiskAlerts } = require('./_lib/team-risk-alerts-runner.js');

const CRON_SECRET = process.env.CRON_SECRET;

async function handler(req, res) {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (auth !== CRON_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' });

  try {
    const result = await runHourlyTeamRiskAlerts();
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron-hourly-team-risk-alerts] fatal:', err && err.message);
    return res.status(err.status || 500).json({ ok: false, error: err && err.message });
  }
}

module.exports = withTelemetry('cron-hourly-team-risk-alerts', handler);
