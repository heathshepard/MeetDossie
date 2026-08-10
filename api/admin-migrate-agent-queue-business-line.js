// One-time migration: add nullable business_line column + check constraint +
// index to public.agent_queue. Run this ONCE manually via CRON_SECRET curl.
// Safe to leave in place / re-run — every clause is IF NOT EXISTS / DROP-then-
// ADD, no data touched.
//
// DDL isn't reachable through PostgREST (no generic SQL-exec RPC is deployed
// on this project), so this connects directly to Postgres with `pg`, using
// POSTGRES_URL_NON_POOLING (bypasses PgBouncer — safer for DDL than the
// pooled POSTGRES_URL). Mirrors the SQL tracked at
// supabase/migrations/20260810_agent_queue_business_line.sql.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-08-10 (SV-ENG-JARVIS-TASK-VIZ)

const { Client } = require('pg');

const CRON_SECRET = process.env.CRON_SECRET;
const CONNECTION_STRING = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;

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
  if (!CONNECTION_STRING) {
    return res.status(503).json({ ok: false, error: 'postgres_connection_env_missing' });
  }

  // Supabase's pooler/direct endpoints present a chain Node's default CA
  // store doesn't fully trust from a serverless sandbox — same failure mode
  // documented across Supabase+node-postgres integrations ("self-signed
  // certificate in certificate chain"). This is a one-time, CRON_SECRET-
  // gated admin migration hitting our own project's DB, not a general
  // outbound TLS relaxation, so disabling verification for this single
  // connection is an acceptable, contained tradeoff.
  const client = new Client({
    connectionString: CONNECTION_STRING,
    ssl: { rejectUnauthorized: false, require: true },
  });

  try {
    await client.connect();
    await client.query(SQL);
    return res.status(200).json({
      ok: true,
      message: 'agent_queue.business_line column + constraint + index added successfully',
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: 'Failed to add business_line column',
      details: err.message,
      code: err.code,
      hasNonPooling: !!process.env.POSTGRES_URL_NON_POOLING,
      hasPooled: !!process.env.POSTGRES_URL,
      usedVar: process.env.POSTGRES_URL_NON_POOLING ? 'POSTGRES_URL_NON_POOLING' : (process.env.POSTGRES_URL ? 'POSTGRES_URL' : 'none'),
    });
  } finally {
    await client.end().catch(() => {});
  }
};
