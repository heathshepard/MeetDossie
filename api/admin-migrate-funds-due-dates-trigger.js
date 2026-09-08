// One-time migration: texas_legal_holidays reference table (seeded from
// api/_lib/business-calendar.js — the ONE encoding of the Govt Code 662.003
// holiday formulas) + the BEFORE INSERT/UPDATE trigger that computes
// transactions.option_fee_due_date / earnest_money_due_date on EVERY write
// path (TREC para 5.A + para 5A(2) rollover).
//
// Fixes the 2026-09-03 QA gate failure: the dossier-detail Effective Date
// field writes via a direct client-side supabase upsert that bypasses both
// API endpoints wired in b43f795c — so the due-date columns stayed NULL.
//
// Mirrors the SQL tracked at
//   supabase/migrations/20260903b_texas_legal_holidays_table.sql
//   supabase/migrations/20260903c_transactions_funds_due_dates_trigger.sql
// (both GENERATED from the same _lib module this endpoint requires, so the
// deployed DB and the repo SQL cannot drift).
//
// Safe to re-run: CREATE IF NOT EXISTS / ON CONFLICT / CREATE OR REPLACE /
// DROP TRIGGER IF EXISTS are all idempotent. Re-running after a holiday-list
// change in business-calendar.js is the intended update mechanism.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-03 (Deadline Guardian checklist #1, QA round 2)

const { runAdminSql } = require('./_lib/pg-admin');
const {
  HOLIDAY_SEED_FROM_YEAR,
  HOLIDAY_SEED_TO_YEAR,
  HOLIDAY_TABLE_SQL,
  buildHolidaySeedSql,
  TRIGGER_SQL,
} = require('./_lib/funds-due-dates-trigger-sql');

const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(HOLIDAY_TABLE_SQL + buildHolidaySeedSql() + TRIGGER_SQL);
    return res.status(200).json({
      ok: true,
      message: `texas_legal_holidays seeded ${HOLIDAY_SEED_FROM_YEAR}..${HOLIDAY_SEED_TO_YEAR}; trg_transactions_funds_due_dates installed`,
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({ ok: false, error: 'Failed to install funds due date trigger', details: err.message });
  }
};
