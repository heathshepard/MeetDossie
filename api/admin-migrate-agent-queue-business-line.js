// One-time migration: add nullable business_line column + check constraint +
// index to public.agent_queue. Applied live 2026-08-10. Safe to leave in
// place / re-run — every clause is IF NOT EXISTS / DROP-then-ADD, no data
// touched.
//
// DDL isn't reachable through PostgREST (no generic SQL-exec RPC is deployed
// on this project), so this runs directly against Postgres via the shared
// api/_lib/pg-admin.js helper (POSTGRES_URL_NON_POOLING, bypasses PgBouncer —
// safer for DDL than the pooled POSTGRES_URL). Mirrors the SQL tracked at
// supabase/migrations/20260810_agent_queue_business_line.sql.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-08-10 (SV-ENG-JARVIS-TASK-VIZ)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE agent_queue ADD COLUMN IF NOT EXISTS business_line TEXT;

ALTER TABLE agent_queue DROP CONSTRAINT IF EXISTS agent_queue_business_line_check;
ALTER TABLE agent_queue ADD CONSTRAINT agent_queue_business_line_check
  CHECK (business_line IS NULL OR business_line IN (
    'dossie', 'sawyer', 'brokerage', 'trading', 'shepard-ventures'
  ));

CREATE INDEX IF NOT EXISTS idx_agent_queue_business_line
  ON agent_queue (business_line, status, created_at DESC);
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
      message: 'agent_queue.business_line column + constraint + index added successfully',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to add business_line column',
      details: err.message,
    });
  }
};
