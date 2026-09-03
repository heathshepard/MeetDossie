#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-03 QA-round-2 fix of Deadline Guardian
 * checklist #1: funds-delivery due dates as a DATABASE TRIGGER.
 *
 * Pre-fix state this test proves against (reproduced twice by QA in the real
 * UI): commits b43f795c/6463195a computed option_fee_due_date /
 * earnest_money_due_date only inside api/dossie-update-and-refill.js and
 * api/interactive-editor-update-field.js — but the dossier-detail Effective
 * Date field saves through dossie-app.jsx persistTransaction(), a direct
 * client-side supabase.from('transactions').upsert() that hits PostgREST and
 * never touches either endpoint. Result: contract_effective_date set, both
 * due-date columns NULL, and no DB safety net.
 *
 * The fix installs trg_transactions_funds_due_dates (BEFORE INSERT OR UPDATE
 * OF contract_effective_date) reading a texas_legal_holidays table that is
 * GENERATED from api/_lib/business-calendar.js — one encoding of the Govt
 * Code 662.003 holiday formulas, not a third.
 *
 * Covers:
 *   1. Migration files exist and are byte-identical to what the generator
 *      produces from business-calendar.js (no drift between JS truth, repo
 *      SQL, and — via the shared _lib module — the admin-migrate endpoint).
 *   2. Seed parity: every date in the checked-in seed matches
 *      texasLegalHolidays() for 2024..2100, and coverage runs >= 20 years
 *      out (expiry flagged decades early).
 *   3. Trigger SQL invariants: fires on INSERT and UPDATE OF
 *      contract_effective_date; caller-changed values win (IS NOT DISTINCT
 *      FROM precedence); coverage guard returns NULL instead of a wrong date.
 *   4. LIVE (when Supabase creds are present, e.g. .env.local): SQL-vs-JS
 *      parity of trec_5a_funds_due_date() via PostgREST RPC across the QA
 *      cases plus a 2026..2028 sweep — including Labor Day, Juneteenth and
 *      Thanksgiving-Friday chains and the 2027/2028 no-expiry check.
 *
 * Run manually:
 *   node scripts/regression-funds-due-date-trigger.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const LIB_PATH = path.join(ROOT, 'api', '_lib', 'funds-due-dates-trigger-sql.js');
const GEN_PATH = path.join(ROOT, 'scripts', 'generate-texas-legal-holidays-migration.js');
const MIG_TABLE = path.join(ROOT, 'supabase', 'migrations', '20260903b_texas_legal_holidays_table.sql');
const MIG_TRIGGER = path.join(ROOT, 'supabase', 'migrations', '20260903c_transactions_funds_due_dates_trigger.sql');

// Load .env.local for the optional live checks (never printed).
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?\r?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch (_) { /* env optional for the local-only sections */ }

const SUPA_URL = process.env.SUPABASE_URL_USABLE || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LIVE = !!(SUPA_URL && SERVICE_KEY && SERVICE_KEY !== '[SENSITIVE]');

async function rpcDueDate(effective) {
  const res = await fetch(`${SUPA_URL}/rest/v1/rpc/trec_5a_funds_due_date`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ effective }),
  });
  if (!res.ok) throw new Error(`rpc trec_5a_funds_due_date(${effective}) -> HTTP ${res.status}: ${await res.text()}`);
  return res.json(); // 'YYYY-MM-DD' or null
}

async function main() {
  console.log('funds due date TRIGGER regression — QA round 2 fix (2026-09-03)');
  console.log('=========================================================================================');

  assert.ok(fs.existsSync(LIB_PATH), `missing ${LIB_PATH} (pre-fix code)`);
  assert.ok(fs.existsSync(GEN_PATH), `missing ${GEN_PATH} (pre-fix code)`);
  const lib = require(LIB_PATH);
  const bc = require(path.join(ROOT, 'api', '_lib', 'business-calendar.js'));

  const CASES = [
    // --- 1. Generated migrations match the JS source exactly ---------------
    ['checked-in migration files exist (the pre-fix tree has neither)',
      () => {
        assert.ok(fs.existsSync(MIG_TABLE), `missing ${MIG_TABLE}`);
        assert.ok(fs.existsSync(MIG_TRIGGER), `missing ${MIG_TRIGGER}`);
      }],
    ['migration files are byte-identical to a fresh regeneration from business-calendar.js',
      () => {
        const { buildFiles } = require(GEN_PATH); // pure builder — does NOT rewrite the files
        const expected = buildFiles();
        assert.strictEqual(fs.readFileSync(MIG_TABLE, 'utf8'), expected['20260903b_texas_legal_holidays_table.sql'], 'holiday table migration drifted — re-run the generator');
        assert.strictEqual(fs.readFileSync(MIG_TRIGGER, 'utf8'), expected['20260903c_transactions_funds_due_dates_trigger.sql'], 'trigger migration drifted — re-run the generator');
      }],

    // --- 2. Seed parity + coverage horizon ---------------------------------
    ['every seeded holiday matches texasLegalHolidays() for every year 2024..2100 (single-encoding guarantee)',
      () => {
        const sql = fs.readFileSync(MIG_TABLE, 'utf8');
        const seeded = [...sql.matchAll(/\('(\d{4}-\d{2}-\d{2})', '((?:[^']|'')+)'\)/g)].map((m) => m[1]);
        assert.ok(seeded.length >= 800, `implausibly small seed (${seeded.length} rows)`);
        const seededSet = new Set(seeded);
        for (let y = lib.HOLIDAY_SEED_FROM_YEAR; y <= lib.HOLIDAY_SEED_TO_YEAR; y++) {
          const expected = bc.texasLegalHolidays(y);
          for (const d of expected) assert.ok(seededSet.has(d), `JS holiday ${d} missing from seed`);
        }
        const expectedTotal = (lib.HOLIDAY_SEED_TO_YEAR - lib.HOLIDAY_SEED_FROM_YEAR + 1) * 11;
        assert.strictEqual(seeded.length, expectedTotal, 'seed contains extra rows not produced by texasLegalHolidays()');
      }],
    ['coverage horizon: seed runs at least 20 years past today (nothing quietly expires on us)',
      () => {
        const nowYear = new Date().getUTCFullYear();
        assert.ok(lib.HOLIDAY_SEED_TO_YEAR >= nowYear + 20, `holiday seed ends ${lib.HOLIDAY_SEED_TO_YEAR}; regenerate with a longer horizon`);
      }],

    // --- 3. Trigger SQL invariants ------------------------------------------
    ['trigger fires BEFORE INSERT OR UPDATE OF contract_effective_date on transactions',
      () => {
        assert.match(lib.TRIGGER_SQL, /BEFORE INSERT OR UPDATE OF contract_effective_date ON public\.transactions/);
        assert.match(lib.TRIGGER_SQL, /CREATE TRIGGER trg_transactions_funds_due_dates/);
      }],
    ['precedence: caller-CHANGED due dates win; untouched columns are recomputed (IS NOT DISTINCT FROM guard)',
      () => {
        const updates = lib.TRIGGER_SQL.match(/IS NOT DISTINCT FROM/g) || [];
        assert.ok(updates.length >= 2, 'both due-date columns must carry the untouched-column guard');
        assert.match(lib.TRIGGER_SQL, /NEW\.contract_effective_date IS DISTINCT FROM OLD\.contract_effective_date/);
      }],
    ['coverage guard: expired holiday table returns NULL + WARNING, never a legally wrong date and never a blocked save',
      () => {
        assert.match(lib.TRIGGER_SQL, /RAISE WARNING/);
        assert.match(lib.TRIGGER_SQL, /holiday_date >= d \+ 30/);
        assert.doesNotMatch(lib.TRIGGER_SQL, /RAISE EXCEPTION/);
      }],
    ['holiday table is read-only via REST: RLS enabled, SELECT-only policy, no write policies',
      () => {
        assert.match(lib.HOLIDAY_TABLE_SQL, /ENABLE ROW LEVEL SECURITY/);
        assert.match(lib.HOLIDAY_TABLE_SQL, /FOR SELECT USING \(true\)/);
        assert.doesNotMatch(lib.HOLIDAY_TABLE_SQL, /FOR (INSERT|UPDATE|DELETE|ALL)/);
      }],
    ['SQL encodes only the generic 5A(2) loop + the 3-day count — zero holiday dates hardcoded in the trigger',
      () => {
        assert.doesNotMatch(lib.TRIGGER_SQL, /\d{4}-\d{2}-\d{2}/, 'trigger SQL must not hardcode any holiday date');
        assert.match(lib.TRIGGER_SQL, new RegExp(`effective \\+ ${bc.TREC_5A_DELIVERY_DAYS}`));
      }],
  ];

  // --- 4. LIVE SQL-vs-JS parity (skipped without creds) ---------------------
  if (LIVE) {
    CASES.push(
      ['LIVE: QA cases — Friday no-roll, Labor Day chain, Juneteenth, Thanksgiving-Friday, NULL clear',
        async () => {
          assert.strictEqual(await rpcDueDate('2026-08-21'), '2026-08-24'); // Friday -> Monday, no rollover
          assert.strictEqual(await rpcDueDate('2026-09-02'), '2026-09-08'); // Sat->Sun->Labor Day->Tue
          assert.strictEqual(await rpcDueDate('2026-06-16'), '2026-06-22'); // lands Juneteenth Fri -> Mon
          assert.strictEqual(await rpcDueDate('2026-11-23'), '2026-11-30'); // Thanksgiving Thu -> Fri(b)(6) -> Sat -> Sun -> Mon
          assert.strictEqual(await rpcDueDate(null), null);                 // clear
        }],
      ['LIVE: 2027/2028 do not expire — Labor Day 2027 and Juneteenth 2028 chains match JS',
        async () => {
          assert.strictEqual(await rpcDueDate('2027-09-01'), bc.computeFundsDeliveryDueDates('2027-09-01').option_fee_due_date);
          assert.strictEqual(await rpcDueDate('2027-09-01'), '2027-09-07'); // Sat 9/4 -> Sun -> Labor Day Mon 9/6 -> Tue
          assert.strictEqual(await rpcDueDate('2028-06-16'), bc.computeFundsDeliveryDueDates('2028-06-16').option_fee_due_date);
          assert.strictEqual(await rpcDueDate('2028-06-16'), '2028-06-20'); // Mon 6/19 Juneteenth -> Tue
        }],
      ['LIVE: SQL-vs-JS parity sweep — every 11th day of 2026..2028 (~100 dates) agrees exactly',
        async () => {
          let d = '2026-01-02';
          let checked = 0;
          while (d <= '2028-12-31') {
            const js = bc.computeFundsDeliveryDueDates(d).option_fee_due_date;
            const sql = await rpcDueDate(d);
            assert.strictEqual(sql, js, `divergence at effective=${d}: SQL=${sql} JS=${js}`);
            checked++;
            d = bc.addCalendarDaysYMD(d, 11);
          }
          assert.ok(checked >= 90, `sweep too small (${checked})`);
        }],
    );
  } else {
    console.log('  SKIP: live SQL-vs-JS parity checks (no usable Supabase creds in env)');
  }

  let failed = 0;
  for (const [label, fn] of CASES) {
    try {
      await fn();
      console.log('  PASS:', label);
    } catch (e) {
      failed++;
      console.error('  FAIL:', label, '—', e && e.message);
    }
  }
  console.log('=========================================================================================');
  if (failed) {
    console.log(failed + ' test(s) FAILED');
    process.exit(1);
  }
  console.log('All tests passed');
}

main().catch((e) => {
  console.error('FATAL:', (e && e.stack) || e);
  process.exit(1);
});
