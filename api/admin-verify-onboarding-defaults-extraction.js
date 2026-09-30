// TEMPORARY read-only verification endpoint for the
// onboarding_defaults_extraction migration (20260930d). Confirms columns,
// table, RLS enabled, and policies via direct Postgres read-only queries.
// Deployed to staging only, to be removed after verification.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-09-30 (temp verification, remove after use)

const { runAdminSql } = require('./_lib/pg-admin');
const { Client } = require('pg');

const CRON_SECRET = process.env.CRON_SECRET;
const CONNECTION_STRING = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!CONNECTION_STRING) {
    return res.status(503).json({ ok: false, error: 'postgres_connection_env_missing' });
  }

  const prevReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();

    const cols = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles'
        AND column_name IN ('team_name','designated_broker_name','designated_broker_license',
                             'license_validation_status','license_validation_checked_at','license_validation_notes')
      ORDER BY column_name;
    `);

    const tbl = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name='onboarding_document_extractions';
    `);

    const rls = await client.query(`
      SELECT relrowsecurity FROM pg_class
      WHERE relname = 'onboarding_document_extractions' AND relnamespace = 'public'::regnamespace;
    `);

    const policies = await client.query(`
      SELECT polname, polcmd,
        pg_get_expr(polqual, polrelid) as using_expr,
        pg_get_expr(polwithcheck, polrelid) as with_check_expr
      FROM pg_policy
      WHERE polrelid = 'public.onboarding_document_extractions'::regclass
      ORDER BY polname;
    `);

    const constraint = await client.query(`
      SELECT conname FROM pg_constraint WHERE conname = 'profiles_license_validation_status_check';
    `);

    return res.status(200).json({
      ok: true,
      profiles_columns: cols.rows,
      table_exists: tbl.rows.length > 0,
      rls_enabled: rls.rows[0] ? rls.rows[0].relrowsecurity : null,
      policies: policies.rows,
      constraint_exists: constraint.rows.length > 0,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    await client.end();
    if (prevReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevReject;
  }
};
