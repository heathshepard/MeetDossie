// One-time DDL: set REPLICA IDENTITY FULL on public.jarvis_balls and
// public.jarvis_todos.
//
// Why: scripts/jarvis-bridge/server.ts (Atlas, 2026-08-13) subscribes to
// Supabase Realtime postgres_changes on these two tables so the live
// jarvis-bridge Claude Code session can notice a direct edit (Heath through
// the PWA UI, another agent, a raw DB write) without being told in
// conversation. Confirmed live 2026-08-13: with Postgres's default
// REPLICA IDENTITY (primary key only), the `old` record on UPDATE/DELETE
// realtime events only carries the row's `id` — every other column reads
// back `undefined`, so an UPDATE diff or a DELETE summary can't say what
// actually changed or what was removed. REPLICA IDENTITY FULL makes
// Postgres log the complete pre-image on every UPDATE/DELETE so Realtime's
// `old` payload is the full row. Standard, documented Postgres feature;
// costs a bit more WAL per write on two low-volume, single-tenant tables —
// no schema/RLS/app-behavior change, nothing else is affected. Safe to
// re-run (ALTER TABLE ... REPLICA IDENTITY FULL is idempotent).
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-08-13 (jarvis-bridge ambient DB-change awareness)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.jarvis_balls REPLICA IDENTITY FULL;
ALTER TABLE public.jarvis_todos REPLICA IDENTITY FULL;
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
      message: 'jarvis_balls + jarvis_todos set to REPLICA IDENTITY FULL',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to set REPLICA IDENTITY FULL',
      details: err.message,
    });
  }
};
