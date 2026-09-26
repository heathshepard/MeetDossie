'use strict';

// One-time migration: video_library.scheduled_for + local_video_orphans +
// the two outcome_expectations rows that wire the video-posting alarm into
// the existing outcome monitor. Reads
// supabase/migrations/20260925_video_scheduling_and_orphan_alarm.sql at
// runtime rather than duplicating it, so the file on disk stays the single
// source of truth — same pattern as api/admin-migrate-outcome-monitor.js.
//
// DDL isn't reachable through PostgREST, so this runs directly against
// Postgres via api/_lib/pg-admin.js (POSTGRES_URL_NON_POOLING).
//
// Idempotent: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / CREATE
// INDEX IF NOT EXISTS / INSERT ... ON CONFLICT DO NOTHING. Safe to re-run.
//
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://<preview-or-prod>/api/admin-migrate-video-scheduling
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-09-25

const fs = require('fs');
const path = require('path');
const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;
const MIGRATION = 'supabase/migrations/20260925_video_scheduling_and_orphan_alarm.sql';

function readMigration() {
  const candidates = [
    path.join(process.cwd(), MIGRATION),
    path.join(__dirname, '..', MIGRATION),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return { sql: fs.readFileSync(p, 'utf8'), path: p }; } catch { /* next */ }
  }
  return { sql: null, path: null };
}

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const { sql, path: found } = readMigration();
  if (!sql) {
    return res.status(500).json({
      ok: false,
      error: `migration file not bundled: ${MIGRATION}`,
      hint: 'vercel.json functions block must grant this route includeFiles for supabase/migrations/**',
    });
  }
  try {
    await runAdminSql(sql);
    return res.status(200).json({
      ok: true,
      message: 'video_library.scheduled_for + local_video_orphans + 2 outcome_expectations rows created',
      ranFrom: found,
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to run video-scheduling migration',
      details: err.message,
    });
  }
};
