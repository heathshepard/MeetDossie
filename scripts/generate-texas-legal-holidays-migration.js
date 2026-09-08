#!/usr/bin/env node
'use strict';

// scripts/generate-texas-legal-holidays-migration.js
//
// Writes the checked-in migration files for the texas_legal_holidays table
// and the transactions funds-due-dates trigger FROM the single JS source
// (api/_lib/funds-due-dates-trigger-sql.js, which itself seeds from
// api/_lib/business-calendar.js). Never hand-edit the output files — edit
// business-calendar.js and re-run this:
//
//   node scripts/generate-texas-legal-holidays-migration.js
//
// scripts/regression-funds-due-date-trigger.js fails if the checked-in files
// drift from what this generator produces.

const fs = require('fs');
const path = require('path');
const {
  HOLIDAY_SEED_FROM_YEAR,
  HOLIDAY_SEED_TO_YEAR,
  HOLIDAY_TABLE_SQL,
  buildHolidaySeedSql,
  TRIGGER_SQL,
} = require('../api/_lib/funds-due-dates-trigger-sql');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'supabase', 'migrations');

const HEADER = (what) => `-- GENERATED FILE — DO NOT HAND-EDIT.
-- ${what}
-- Source of truth: api/_lib/business-calendar.js (holiday formulas) via
-- api/_lib/funds-due-dates-trigger-sql.js.
-- Regenerate: node scripts/generate-texas-legal-holidays-migration.js
-- Applied by: api/admin-migrate-funds-due-dates-trigger.js (CRON_SECRET-gated).
`;

// Pure builder — the regression test requires this WITHOUT writing files,
// so drift between the checked-in migrations and the JS source is detected
// rather than silently self-healed.
function buildFiles() {
  return {
    '20260903b_texas_legal_holidays_table.sql':
      HEADER(`texas_legal_holidays reference table + seed ${HOLIDAY_SEED_FROM_YEAR}..${HOLIDAY_SEED_TO_YEAR} (Govt Code 662.003(a)+(b)(4)+(b)(6)).`) +
      HOLIDAY_TABLE_SQL + buildHolidaySeedSql(),
    '20260903c_transactions_funds_due_dates_trigger.sql':
      HEADER('BEFORE INSERT/UPDATE trigger: transactions.option_fee_due_date / earnest_money_due_date computed on EVERY write path (TREC para 5.A + 5A(2)); caller-changed values win.') +
      TRIGGER_SQL,
  };
}

if (require.main === module) {
  for (const [name, sql] of Object.entries(buildFiles())) {
    const dest = path.join(MIGRATIONS_DIR, name);
    fs.writeFileSync(dest, sql);
    console.log(`wrote ${dest} (${sql.length} bytes)`);
  }
}

module.exports = { buildFiles };
