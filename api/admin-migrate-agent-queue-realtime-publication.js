// One-time migration: add public.agent_queue to the supabase_realtime
// publication. Safe to leave in place / re-run — guarded by an existence
// check, no data touched.
//
// WHY: Realtime postgres_changes events are gated on publication membership,
// separate from RLS. agent_queue had the agent_queue_heath_read SELECT
// policy but was never added to the publication, so the BUSINESS LINES
// panel's agent_queue_stream channel received zero events regardless of RLS.
// Mirrors the SQL tracked at
// supabase/migrations/20260810_agent_queue_realtime_publication.sql.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-08-10 (SV-ENG-JARVIS-TASK-VIZ)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'agent_queue'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE agent_queue;
  END IF;
END $$;
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
      message: 'agent_queue added to supabase_realtime publication',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to add agent_queue to supabase_realtime publication',
      details: err.message,
    });
  }
};
