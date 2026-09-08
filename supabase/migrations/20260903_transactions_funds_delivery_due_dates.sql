-- Option fee / earnest money delivery due dates (TREC ¶5.A).
--
-- Deadline Guardian checklist item #1 (docs/DOSSIE-DEADLINE-GUARDIAN-SPEC.md).
-- The transactions table already carries option_fee_amount /
-- earnest_money_amount and the *receipt* timestamps (option_fee_receipt_date,
-- earnest_money_deposited_at) but had no *due-date* column for either — so
-- cron-deadline-reminders.js could not remind against the two deadlines that
-- caused the real $5,200 loss the spec documents.
--
-- Both columns are computed by api/_lib/business-calendar.js when
-- contract_effective_date is set or changed: effective date + 3 calendar days
-- (¶5.A default), then the ¶5A(2) weekend/Texas-Legal-Holiday rollover —
-- which applies ONLY to these funds-delivery deadlines, never to option
-- expiration / survey / financing / appraisal / closing.
--
-- Nullable by design; existing live rows are NOT backfilled with a guess.
-- The reminder cron derives an in-memory due date from
-- contract_effective_date for rows where the column is still NULL, so
-- reminders work without mutating historical rows.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS option_fee_due_date DATE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS earnest_money_due_date DATE;

COMMENT ON COLUMN transactions.option_fee_due_date IS 'TREC ¶5.A option fee delivery deadline: contract_effective_date + 3 calendar days, then ¶5A(2) weekend/Texas Legal Holiday rollover. Computed by api/_lib/business-calendar.js; NULL means never computed (no effective date, or row predates the column).';
COMMENT ON COLUMN transactions.earnest_money_due_date IS 'TREC ¶5.A earnest money delivery deadline: contract_effective_date + 3 calendar days, then ¶5A(2) weekend/Texas Legal Holiday rollover. Computed by api/_lib/business-calendar.js; NULL means never computed (no effective date, or row predates the column).';
