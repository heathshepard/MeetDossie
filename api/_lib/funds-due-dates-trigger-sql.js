// api/_lib/funds-due-dates-trigger-sql.js
//
// SINGLE SOURCE for the SQL that makes TREC ¶5.A funds-delivery due dates a
// database guarantee instead of an application courtesy.
//
// WHY A TRIGGER (2026-09-03, QA gate failure): commits b43f795c/6463195a
// wired computeFundsDeliveryDueDates() into dossie-update-and-refill.js and
// interactive-editor-update-field.js — but the field a member actually edits
// on the dossier detail page goes through dossie-app.jsx persistTransaction(),
// a direct client-side supabase.from('transactions').upsert() that no API
// endpoint ever sees. QA reproduced it twice: contract_effective_date saved,
// both due-date columns stayed NULL. There are at least four write paths
// (UI upsert, chat, the two API endpoints, raw REST); patching call sites one
// at a time is whack-a-mole. A BEFORE INSERT/UPDATE trigger fires on every
// path by construction.
//
// WHY A HOLIDAY *TABLE*, NOT SQL HOLIDAY LOGIC: the Texas Legal Holiday rule
// (Gov't Code §662.003(a) + (b)(4) Juneteenth + (b)(6) Friday after
// Thanksgiving) already has two encodings — api/_lib/business-calendar.js
// here and src/utils/trec-deadline-engine.js in the Dossie repo. Re-deriving
// the nth-weekday formulas in PL/pgSQL would make a THIRD encoding of one
// legal rule. Instead the trigger reads public.texas_legal_holidays, and that
// table is GENERATED from business-calendar.js:
//
//   - buildHolidaySeedSql() below calls texasLegalHolidays(year) — the same
//     function the API endpoints and reminder cron use — for 2024..2100.
//   - scripts/generate-texas-legal-holidays-migration.js writes the checked-in
//     migration files from this module. Never hand-edit those files.
//   - api/admin-migrate-funds-due-dates-trigger.js applies this module's SQL
//     directly, so the deployed DB and the repo SQL come from one source.
//   - scripts/regression-funds-due-date-trigger.js re-generates the seed in
//     memory and diffs it against the checked-in migration, then (when creds
//     are available) sweeps JS vs SQL results for parity.
//
// SYNC STORY: if the holiday list ever changes (new statute), edit
// business-calendar.js ONLY, re-run the generator, re-hit the admin endpoint.
// The regression test fails until all three agree.
//
// EXPIRY: seeded through 2100. If the SQL function is ever asked about a date
// beyond coverage it returns NULL with a WARNING rather than computing a
// legally-wrong date or blocking the member's save — and
// cron-deadline-reminders.js already derives an in-memory due date (from the
// never-expiring JS formula) whenever the columns are NULL, so reminders
// survive even that. The regression test asserts >= 20 years of remaining
// coverage so expiry is flagged decades early.
//
// PRECEDENCE RULE (trigger is a backstop, not a competitor): a value the
// caller explicitly CHANGED in the same statement wins — the trigger only
// (re)computes a due-date column the statement left untouched
// (NEW IS NOT DISTINCT FROM OLD). The API endpoints keep computing and
// sending both columns; they and the trigger agree by construction (same
// holiday data), which the regression parity sweep enforces.

'use strict';

const { texasLegalHolidays, TREC_5A_DELIVERY_DAYS } = require('./business-calendar');

const HOLIDAY_SEED_FROM_YEAR = 2024;
const HOLIDAY_SEED_TO_YEAR = 2100;

// Human-readable labels keyed by recomputing which slot a date came from.
function holidayNamesForYear(year) {
  const set = [...texasLegalHolidays(year)].sort();
  // texasLegalHolidays returns a Set; label by month/day pattern.
  return set.map((ymd) => {
    const [, mm, dd] = ymd.split('-');
    const md = `${mm}-${dd}`;
    if (md === '01-01') return [ymd, "New Year's Day"];
    if (md === '06-19') return [ymd, 'Juneteenth'];
    if (md === '07-04') return [ymd, 'Independence Day'];
    if (md === '11-11') return [ymd, 'Veterans Day'];
    if (md === '12-25') return [ymd, 'Christmas Day'];
    if (mm === '01') return [ymd, 'MLK Day'];
    if (mm === '02') return [ymd, "Presidents' Day"];
    if (mm === '05') return [ymd, 'Memorial Day'];
    if (mm === '09') return [ymd, 'Labor Day'];
    // November: 4th Thursday vs the Friday after.
    const dow = new Date(Date.UTC(year, 10, Number(dd))).getUTCDay();
    return [ymd, dow === 4 ? 'Thanksgiving Day' : 'Friday after Thanksgiving'];
  });
}

// CREATE TABLE + RLS. Read-only reference data, public by nature (statute
// dates) — SELECT open to every role so the trigger works under RLS for
// authenticated/anon REST writes; no INSERT/UPDATE/DELETE policies exist, so
// PostgREST callers cannot mutate it (only the service role / direct SQL can).
const HOLIDAY_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS public.texas_legal_holidays (
  holiday_date DATE PRIMARY KEY,
  holiday_name TEXT NOT NULL
);

COMMENT ON TABLE public.texas_legal_holidays IS
  'Texas Legal Holidays for TREC para 5A(2) rollover: Govt Code 662.003(a) national list + (b)(4) Juneteenth + (b)(6) Friday after Thanksgiving. Texas-only observances deliberately excluded. GENERATED from api/_lib/business-calendar.js via scripts/generate-texas-legal-holidays-migration.js — never hand-edit; edit business-calendar.js and regenerate.';

ALTER TABLE public.texas_legal_holidays ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS texas_legal_holidays_read_all ON public.texas_legal_holidays;
CREATE POLICY texas_legal_holidays_read_all ON public.texas_legal_holidays
  FOR SELECT USING (true);
`;

function buildHolidaySeedSql(fromYear = HOLIDAY_SEED_FROM_YEAR, toYear = HOLIDAY_SEED_TO_YEAR) {
  const values = [];
  for (let year = fromYear; year <= toYear; year++) {
    for (const [ymd, name] of holidayNamesForYear(year)) {
      values.push(`  ('${ymd}', '${name.replace(/'/g, "''")}')`);
    }
  }
  return `
-- Seed ${fromYear}..${toYear} (${values.length} rows), generated from
-- api/_lib/business-calendar.js texasLegalHolidays(). ON CONFLICT keeps
-- re-runs and regenerated supersets idempotent.
INSERT INTO public.texas_legal_holidays (holiday_date, holiday_name) VALUES
${values.join(',\n')}
ON CONFLICT (holiday_date) DO UPDATE SET holiday_name = EXCLUDED.holiday_name;
`;
}

// The rollover function + trigger. Contains ZERO holiday knowledge — only the
// generic para 5A(2) roll-forward loop (weekend or listed holiday -> next day)
// and the +3 calendar day count from TREC para 5.A.
const TRIGGER_SQL = `
CREATE OR REPLACE FUNCTION public.trec_5a_funds_due_date(effective DATE)
RETURNS DATE
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $fn$
DECLARE
  d DATE;
BEGIN
  IF effective IS NULL THEN
    RETURN NULL;
  END IF;
  d := effective + ${TREC_5A_DELIVERY_DAYS}; -- TREC para 5.A: 3 calendar days
  -- Coverage guard: never compute against an expired holiday table — a
  -- missing holiday would silently produce a legally wrong deadline. Return
  -- NULL instead (cron-deadline-reminders.js derives in-memory from
  -- contract_effective_date when the column is NULL, so reminders survive).
  IF NOT EXISTS (
    SELECT 1 FROM public.texas_legal_holidays WHERE holiday_date >= d + 30
  ) THEN
    RAISE WARNING 'texas_legal_holidays coverage ends before % + 30 days; returning NULL — regenerate via scripts/generate-texas-legal-holidays-migration.js', d;
    RETURN NULL;
  END IF;
  -- para 5A(2): while the date is a Saturday, Sunday, or Texas Legal Holiday,
  -- extend to the next day (rolls repeatedly: Sat -> Sun -> holiday Mon -> Tue).
  WHILE EXTRACT(ISODOW FROM d) IN (6, 7)
     OR EXISTS (SELECT 1 FROM public.texas_legal_holidays WHERE holiday_date = d)
  LOOP
    d := d + 1;
  END LOOP;
  RETURN d;
END;
$fn$;

COMMENT ON FUNCTION public.trec_5a_funds_due_date(DATE) IS
  'TREC para 5.A funds-delivery due date: effective + 3 calendar days, then para 5A(2) weekend/Texas Legal Holiday rollover (reads texas_legal_holidays). Returns NULL for NULL input or when holiday coverage has expired. Mirrors api/_lib/business-calendar.js computeFundsDeliveryDueDates(); parity enforced by scripts/regression-funds-due-date-trigger.js.';

CREATE OR REPLACE FUNCTION public.transactions_set_funds_due_dates()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Fill only what the caller left NULL; an explicitly supplied value wins.
    IF NEW.contract_effective_date IS NOT NULL THEN
      IF NEW.option_fee_due_date IS NULL THEN
        NEW.option_fee_due_date := public.trec_5a_funds_due_date(NEW.contract_effective_date);
      END IF;
      IF NEW.earnest_money_due_date IS NULL THEN
        NEW.earnest_money_due_date := public.trec_5a_funds_due_date(NEW.contract_effective_date);
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: act only when the effective date actually changed. A due-date
  -- column the statement CHANGED (NEW IS DISTINCT FROM OLD) belongs to the
  -- caller — the API endpoints compute and send both columns and must win.
  -- A column the statement left untouched is (re)computed, which also
  -- clears both when the effective date is cleared (function returns NULL).
  IF NEW.contract_effective_date IS DISTINCT FROM OLD.contract_effective_date THEN
    IF NEW.option_fee_due_date IS NOT DISTINCT FROM OLD.option_fee_due_date THEN
      NEW.option_fee_due_date := public.trec_5a_funds_due_date(NEW.contract_effective_date);
    END IF;
    IF NEW.earnest_money_due_date IS NOT DISTINCT FROM OLD.earnest_money_due_date THEN
      NEW.earnest_money_due_date := public.trec_5a_funds_due_date(NEW.contract_effective_date);
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_transactions_funds_due_dates ON public.transactions;
CREATE TRIGGER trg_transactions_funds_due_dates
  BEFORE INSERT OR UPDATE OF contract_effective_date ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.transactions_set_funds_due_dates();
`;

module.exports = {
  HOLIDAY_SEED_FROM_YEAR,
  HOLIDAY_SEED_TO_YEAR,
  HOLIDAY_TABLE_SQL,
  buildHolidaySeedSql,
  TRIGGER_SQL,
};
