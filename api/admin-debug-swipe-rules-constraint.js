// Temporary debug endpoint: report the CHECK constraint definition on
// sage_swipe_rules.rule_type (pre-existing, undocumented scaffold) so the
// external-trend-research insert script can use an allowed value.
// Safe/read-only. Delete after use.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Owner: Sage, 2026-08-28 (throwaway debug tool)

const { Client } = require('pg');

const CRON_SECRET = process.env.CRON_SECRET;
const CONNECTION_STRING = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!CONNECTION_STRING) {
    return res.status(503).json({ ok: false, error: 'postgres_connection_env_missing' });
  }

  const prevTlsFlag = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false, require: true } });
  try {
    await client.connect();
    const r = await client.query(`
      SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'public.sage_swipe_rules'::regclass
    `);
    return res.status(200).json({ ok: true, constraints: r.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    await client.end().catch(() => {});
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTlsFlag;
  }
};
