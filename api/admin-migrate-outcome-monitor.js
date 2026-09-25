'use strict';

// One-time migration: create the outcome monitor's four tables and seed the
// expectation set. Reads supabase/migrations/20260925_outcome_monitor.sql at
// runtime rather than duplicating it, so the file on disk stays the single
// source of truth. DDL is not reachable through PostgREST, so this runs
// directly against Postgres via api/_lib/pg-admin.js — same pattern as
// api/admin-migrate-batch-digest-and-alerts.js.
//
// Idempotent: every statement is CREATE TABLE IF NOT EXISTS / CREATE INDEX IF
// NOT EXISTS / INSERT ... ON CONFLICT DO NOTHING. Safe to re-run.
//
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://<preview-or-prod>/api/admin-migrate-outcome-monitor
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-09-25

const fs = require('fs');
const path = require('path');
const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;
const MIGRATION = 'supabase/migrations/20260925_outcome_monitor.sql';

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
      migrated: 'outcome_expectations + outcome_checks + outcome_incidents + credential_health (seeded)',
      from: found,
    });
  } catch (err) {
    console.error('[admin-migrate-outcome-monitor]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
