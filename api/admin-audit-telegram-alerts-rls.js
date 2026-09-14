'use strict';

// TEMPORARY read-only audit endpoint — telegram_send_log / weekly_digest_surfaces
// / alert_state RLS investigation (Carter, 2026-09-14). Same connection
// pattern as api/_lib/pg-admin.js but SELECT-only, returns rows as JSON so
// the live rowsecurity/policy/grant state can be confirmed before writing
// the actual RLS migration. Remove this file once the audit is done.
//
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://<preview>/api/admin-audit-telegram-alerts-rls
//
// Owner: Carter, 2026-09-14

const { Client } = require('pg');

const CRON_SECRET = process.env.CRON_SECRET;
const CONNECTION_STRING = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;

const TABLES = ['telegram_send_log', 'weekly_digest_surfaces', 'alert_state'];

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!CONNECTION_STRING) {
    return res.status(500).json({ ok: false, error: 'postgres_connection_env_missing' });
  }

  const prevTlsFlag = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const client = new Client({
    connectionString: CONNECTION_STRING,
    ssl: { rejectUnauthorized: false, require: true },
  });

  try {
    await client.connect();

    const rls = await client.query(
      `select relname, relrowsecurity, relforcerowsecurity
       from pg_class
       where relname = ANY($1) and relnamespace = 'public'::regnamespace`,
      [TABLES]
    );

    const policies = await client.query(
      `select tablename, policyname, cmd, roles, qual, with_check
       from pg_policies
       where schemaname='public' and tablename = ANY($1)`,
      [TABLES]
    );

    const grants = await client.query(
      `select table_name, grantee, privilege_type
       from information_schema.role_table_grants
       where table_schema='public' and table_name = ANY($1)
         and grantee in ('anon','authenticated','service_role')
       order by table_name, grantee, privilege_type`,
      [TABLES]
    );

    const details = {};
    for (const t of TABLES) {
      const cnt = await client.query(`select count(*)::int as n from public.${t}`);
      const cols = await client.query(
        `select column_name, data_type, is_nullable
         from information_schema.columns
         where table_schema='public' and table_name=$1
         order by ordinal_position`,
        [t]
      );
      details[t] = { row_count: cnt.rows[0].n, columns: cols.rows };
    }

    return res.status(200).json({
      ok: true,
      rls: rls.rows,
      policies: policies.rows,
      grants: grants.rows,
      details,
    });
  } catch (err) {
    console.error('[admin-audit-telegram-alerts-rls]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    await client.end().catch(() => {});
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTlsFlag;
  }
};
