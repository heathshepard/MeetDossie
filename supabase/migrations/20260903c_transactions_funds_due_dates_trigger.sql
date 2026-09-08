-- GENERATED FILE — DO NOT HAND-EDIT.
-- BEFORE INSERT/UPDATE trigger: transactions.option_fee_due_date / earnest_money_due_date computed on EVERY write path (TREC para 5.A + 5A(2)); caller-changed values win.
-- Source of truth: api/_lib/business-calendar.js (holiday formulas) via
-- api/_lib/funds-due-dates-trigger-sql.js.
-- Regenerate: node scripts/generate-texas-legal-holidays-migration.js
-- Applied by: api/admin-migrate-funds-due-dates-trigger.js (CRON_SECRET-gated).

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
  d := effective + 3; -- TREC para 5.A: 3 calendar days
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
