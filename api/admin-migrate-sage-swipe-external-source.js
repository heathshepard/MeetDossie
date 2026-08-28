// One-time migration: add source-tagging + pattern-only columns to the
// existing (previously uncoded) sage_swipe_items / sage_swipe_rules /
// sage_swipe_watchlist tables, for the external trend-research pass.
// Safe to re-run -- ADD COLUMN IF NOT EXISTS + DROP/CREATE CONSTRAINT throughout,
// no data touched (tables were empty at time of writing).
//
// DDL isn't reachable through PostgREST, so this runs directly against
// Postgres via api/_lib/pg-admin.js (POSTGRES_URL_NON_POOLING). Mirrors
// supabase/migrations/20260828190000_sage_swipe_external_source.sql and the
// exact pattern of api/admin-migrate-comment-watchlist.js.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Sage, 2026-08-28

const fs = require('fs');
const path = require('path');
const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20260828190000_sage_swipe_external_source.sql'),
  'utf8',
);

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
      message: 'sage_swipe_* external-source columns + constraints applied successfully',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to migrate sage_swipe_* tables',
      detail: err.message,
    });
  }
};
