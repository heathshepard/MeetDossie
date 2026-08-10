// TEMPORARY diagnostic endpoint — not for long-term use, delete after
// SV-ENG-JARVIS-TASK-VIZ realtime debugging is resolved.
// Auth: Authorization: Bearer ${CRON_SECRET}

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

  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const client = new Client({
    connectionString: CONNECTION_STRING,
    ssl: { rejectUnauthorized: false, require: true },
  });

  try {
    await client.connect();
    const pub = await client.query(
      `select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by tablename;`
    );
    const policies = await client.query(
      `select policyname, cmd, roles::text, qual from pg_policies where tablename = 'agent_queue';`
    );
    const replident = await client.query(
      `select relreplident from pg_class where relname = 'agent_queue';`
    );
    return res.status(200).json({
      ok: true,
      publication_tables: pub.rows.map((r) => r.tablename),
      agent_queue_in_publication: pub.rows.some((r) => r.tablename === 'agent_queue'),
      agent_queue_policies: policies.rows,
      agent_queue_replica_identity: replident.rows[0],
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    await client.end().catch(() => {});
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
  }
};
