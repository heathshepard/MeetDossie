// api/_lib/pg-admin.js — direct-Postgres DDL runner for one-off admin
// migration endpoints.
//
// PostgREST (the REST API SUPABASE_URL exposes) can't run DDL, and no
// generic SQL-exec RPC is deployed on this project. This connects directly
// via `pg`, using POSTGRES_URL_NON_POOLING (bypasses PgBouncer — safer for
// DDL than the pooled POSTGRES_URL).
//
// Owner: Atlas, 2026-08-10 (SV-ENG-JARVIS-TASK-VIZ)

const { Client } = require('pg');

const CONNECTION_STRING = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;

/**
 * Run one or more SQL statements directly against Postgres.
 * @param {string} sql
 * @returns {Promise<void>} throws on failure
 */
async function runAdminSql(sql) {
  if (!CONNECTION_STRING) {
    throw new Error('postgres_connection_env_missing');
  }

  // Supabase's pooler/direct endpoints present a chain Node's default CA
  // store doesn't fully trust from a serverless sandbox — "self-signed
  // certificate in certificate chain", a known failure mode across
  // Supabase+node-postgres integrations. The client-level `ssl` option alone
  // doesn't clear it on this Vercel Node runtime, so this also flips the
  // process-global flag for the life of the call, then restores it. Fine for
  // a short-lived, CRON_SECRET-gated admin migration hitting our own
  // project's DB — not a general outbound TLS relaxation.
  const prevTlsFlag = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const client = new Client({
    connectionString: CONNECTION_STRING,
    ssl: { rejectUnauthorized: false, require: true },
  });

  try {
    await client.connect();
    await client.query(sql);
  } finally {
    await client.end().catch(() => {});
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTlsFlag;
  }
}

module.exports = { runAdminSql };
