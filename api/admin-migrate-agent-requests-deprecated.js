// One-time migration: COMMENT ON TABLE agent_requests, marking it
// deprecated. Does NOT drop, rename, or delete any rows -- see
// supabase/migrations/20260930_agent_requests_deprecated.sql for the full
// rationale (this file runs that same SQL; DDL isn't reachable through
// PostgREST, so it goes through api/_lib/pg-admin.js like every other
// admin-migrate-*.js in this directory).
//
// Safe to re-run -- COMMENT ON TABLE is idempotent (last write wins, no
// data touched either way).
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-09-30 (SV-ENG-AGENT-REQUESTS-DECOY)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
COMMENT ON TABLE agent_requests IS
  'DEPRECATED 2026-09-30 (Atlas). Not a live queue -- its reader '
  '(api/cron-process-agent-requests.js) has not run since 2026-06-10. '
  'Writers (api/cron-staging-watcher.js, api/sage-webhook.js) were switched '
  'to a direct Telegram-notify fallback on 2026-09-30 instead of inserting '
  'here. The live agent dispatch queue is public.agent_queue, not this '
  'table. Rows are preserved (not bulk-closed/deleted) pending Heath '
  'sign-off -- see docs/BACKLOG-ENGINEERING.md item E4.';
`;

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(SQL);
    return res.status(200).json({
      ok: true,
      message: 'agent_requests table comment set to DEPRECATED (no rows touched)',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to comment agent_requests table',
      details: err.message,
    });
  }
};
