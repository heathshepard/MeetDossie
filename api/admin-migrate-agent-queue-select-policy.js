// One-time migration: add a narrow SELECT policy to public.agent_queue for
// Heath's authenticated session. Safe to leave in place / re-run — DROP POLICY
// IF EXISTS + CREATE, no data touched.
//
// WHY: agent_queue has RLS ENABLED with ZERO SELECT policies (see
// 20260617_agent_queue.sql). Correct for writes, but Supabase Realtime
// enforces the same RLS as REST for the connecting role — with zero SELECT
// policies, the browser's `authenticated` session got ZERO postgres_changes
// events on the agent_queue_stream channel. Confirmed live 2026-08-10 while
// building the BUSINESS LINES panel: a direct REST probe as Heath's own
// signed-in session returned 200 [] against a table known to have rows.
//
// This grants read-only access to exactly one identity (Heath's email) —
// NOT a blanket `TO authenticated USING (true)`, since this Supabase project
// is shared with the customer-facing Dossie app. No change to
// INSERT/UPDATE/DELETE, which stay service-role-only via the existing API
// routes. Mirrors the SQL tracked at
// supabase/migrations/20260810_agent_queue_select_policy.sql.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-08-10 (SV-ENG-JARVIS-TASK-VIZ)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;
const HEATH_EMAIL = 'heath.shepard@kw.com';

const SQL = `
DROP POLICY IF EXISTS agent_queue_heath_read ON agent_queue;
CREATE POLICY agent_queue_heath_read ON agent_queue
  FOR SELECT
  TO authenticated
  USING (auth.jwt() ->> 'email' = '${HEATH_EMAIL}');
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
      message: 'agent_queue_heath_read SELECT policy added successfully',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to add agent_queue SELECT policy',
      details: err.message,
    });
  }
};
