// One-time migration for
// supabase/migrations/20260930e_comment_monitor_resumable_cursor.sql — see
// that file for the full incident writeup. Creates the singleton
// cron_comment_monitor_state row cron-comment-monitor.js reads/writes to
// resume its Zernio discovery pagination across ticks, via the same
// direct-Postgres connection every admin-migrate-*.js route uses, since
// PostgREST (SUPABASE_URL) cannot run DDL.
//
// Safe to re-run — CREATE TABLE IF NOT EXISTS / INSERT ... ON CONFLICT DO
// NOTHING are both idempotent.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// ?verify=1 reads the row back to prove it exists and has the expected shape
// — no writes, nothing to roll back.
//
// Owner: Atlas, 2026-09-30

const { runAdminSql } = require('./_lib/pg-admin');
const { Client } = require('pg');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
create table if not exists cron_comment_monitor_state (
  id                       smallint primary key default 1,
  discovery_cursor         text,
  discovery_since          text,
  sweep_started_at         timestamptz,
  last_sweep_completed_at  timestamptz,
  posts_seen_this_sweep    integer not null default 0,
  total_posts_last_sweep   integer,
  updated_at               timestamptz not null default now(),

  constraint cron_comment_monitor_state_singleton check (id = 1)
);

insert into cron_comment_monitor_state (id, discovery_cursor, discovery_since, sweep_started_at)
values (1, null, null, now())
on conflict (id) do nothing;
`;

async function verifyRowExists() {
  const connectionString = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('postgres_connection_env_missing');

  const prevTlsFlag = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false, require: true } });
  try {
    await client.connect();
    const r = await client.query('SELECT * FROM public.cron_comment_monitor_state WHERE id = 1');
    return { tested: true, rowExists: r.rowCount === 1, row: r.rows[0] || null };
  } finally {
    await client.end().catch(() => {});
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTlsFlag;
  }
}

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const doVerify = req.query && (req.query.verify === '1' || req.query.verify === 'true');

  try {
    if (doVerify) {
      const verification = await verifyRowExists();
      return res.status(200).json({ ok: true, verification });
    }
    await runAdminSql(SQL);
    return res.status(200).json({
      ok: true,
      message: 'cron_comment_monitor_state created (or already existed) with its singleton row',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: doVerify ? 'Failed to verify cron_comment_monitor_state' : 'Failed to run comment-monitor-cursor migration',
      details: err.message,
    });
  }
};
