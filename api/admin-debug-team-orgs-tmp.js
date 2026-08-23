// TEMPORARY verification-only endpoint — lists Team/Brokerage orgs + their
// admin members, for finding a real org to seed a test risk condition on
// (SV-ENG-TEAM-RISK-PUSH verification, 2026-08-23). Deleted before this
// feature's staging work is considered done — not a permanent addition.
// Fixed query only, not a general SQL-exec endpoint.
const { Client } = require('pg');
const CRON_SECRET = process.env.CRON_SECRET;
const CONNECTION_STRING = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;

module.exports = async function handler(req, res) {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (auth !== CRON_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!CONNECTION_STRING) return res.status(503).json({ ok: false, error: 'no_pg_conn' });

  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false, require: true } });
  try {
    await client.connect();
    const orgs = await client.query(`
      SELECT o.id, o.name, o.tier, o.created_by_user_id, o.archived_at
      FROM public.organizations o
      WHERE o.tier IN ('team','brokerage')
      ORDER BY o.created_at DESC
      LIMIT 30
    `);
    const members = await client.query(`
      SELECT m.org_id, m.user_id, u.email, array_agg(r.role) as roles
      FROM public.organization_members m
      JOIN auth.users u ON u.id = m.user_id
      LEFT JOIN public.organization_member_roles r ON r.member_id = m.id AND r.revoked_at IS NULL
      WHERE m.removed_at IS NULL
      GROUP BY m.org_id, m.user_id, u.email
      ORDER BY m.org_id
    `);
    return res.status(200).json({ ok: true, orgs: orgs.rows, members: members.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    await client.end().catch(() => {});
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
  }
};
