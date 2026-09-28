'use strict';

// One-time migration: seed ops_flags.video_auto_approve_live (see
// supabase/migrations/20260928_video_auto_approve.sql — keep in sync).
// Safe to re-run — ON CONFLICT DO NOTHING.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Owner: Atlas, 2026-09-28

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
INSERT INTO ops_flags (key, enabled, reason, updated_by) VALUES
  ('video_auto_approve_live',
   false,
   'Advance approved -> heath_approved with no Telegram tap once quality_status=passed cleanly, no TREC claim, not a first-of-format run. OFF = report-mode only.',
   'atlas')
ON CONFLICT (key) DO NOTHING;
`;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    await runAdminSql(SQL);
    return res.status(200).json({ ok: true, message: 'video_auto_approve_live seeded' });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({ ok: false, error: 'Failed to seed flag', details: err.message });
  }
};
