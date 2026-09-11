'use strict';

// TEMPORARY read-only introspection endpoint — RLS security audit on
// listing_marketing_status / listing_marketing_rotation (2026-09-11).
// Not part of the permanent admin-migrate-* convention; delete after use.
//
// Auth: Authorization: Bearer ${CRON_SECRET}

const { runAdminQuery } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;
const TABLES = ['listing_marketing_status', 'listing_marketing_rotation'];

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    const rls = await runAdminQuery(`
      select schemaname, tablename, rowsecurity
      from pg_tables
      where tablename = ANY(ARRAY['${TABLES.join("','")}'])
    `);

    const policies = await runAdminQuery(`
      select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
      from pg_policies
      where tablename = ANY(ARRAY['${TABLES.join("','")}'])
    `);

    const grants = await runAdminQuery(`
      select table_name, grantee, privilege_type
      from information_schema.role_table_grants
      where table_name = ANY(ARRAY['${TABLES.join("','")}'])
        and grantee in ('anon','authenticated','service_role','PUBLIC')
      order by table_name, grantee, privilege_type
    `);

    return res.status(200).json({ ok: true, rls, policies, grants });
  } catch (err) {
    console.error('[admin-inspect-rls-tmp]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
