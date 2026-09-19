-- Option fee CONFIRMED RECEIPT timestamp (TREC ¶5.A / Deadline Guardian Gate 6).
--
-- Why this column has to exist
-- ----------------------------
-- Before this migration the schema had no way to say "title confirmed it got
-- the option fee." It had only option_fee_paid_at, which the workspace stamps
-- with Date.now() during executed-contract upload whenever ¶5.A of the scanned
-- contract shows any option fee amount at all. That timestamp means "a
-- contract mentioning an option fee was filed" — not sent, and certainly not
-- received.
--
-- cron-deadline-reminders.js was suppressing the ¶5.A option-fee delivery
-- reminder on option_fee_paid_at, so the reminder went quiet the moment the
-- executed contract was uploaded — day zero, before anyone had delivered
-- anything. That is exactly the Low Oak failure that cost $5,200: in Texas,
-- an option fee not delivered on time costs the buyer the unrestricted right
-- to terminate, and "marked paid" is not delivery.
--
-- Earnest money already had this distinction (earnest_money_deposited_at =
-- self-reported, earnest_money_confirmed_at = parsed from the page-11 escrow
-- receipt block on the executed contract). option_fee_confirmed_at is the
-- option-fee counterpart so both ¶5.A deadlines suppress on the same,
-- confirmed-receipt basis.
--
-- NOT the same thing as the TREC 20-19 AcroForm key `option_fee_receipt_date`.
-- That is a PDF field name on page 11 (see
-- api/_lib/trec-20-19-transaction-field-map.js), has never been a column on
-- this table, and naming it in a PostgREST select 500'd this cron for a week
-- in September 2026. Do not reintroduce it as a column name.
--
-- Nullable by design; no backfill. There is no historical signal that could
-- honestly be turned into a confirmed receipt, and guessing one here would
-- silence the exact reminder this column exists to keep alive.

ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS option_fee_confirmed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.transactions.option_fee_confirmed_at IS
  'TREC ¶5.A option fee CONFIRMED RECEIPT: the escrow agent/title company acknowledged receiving the funds. The only field that may suppress the option-fee delivery reminder in cron-deadline-reminders.js. NULL means not confirmed — remind.';

COMMENT ON COLUMN public.transactions.option_fee_paid_at IS
  'SELF-REPORTED "option fee paid" marker. Auto-stamped with the upload time when an executed contract is scanned and ¶5.A shows any option fee amount, and hand-editable in the workspace. NOT proof of receipt — never use it to suppress a delivery reminder. Use option_fee_confirmed_at.';

COMMENT ON COLUMN public.transactions.earnest_money_deposited_at IS
  'SELF-REPORTED "earnest money deposited/sent" marker. Auto-stamped with the upload time when an executed contract is scanned and ¶5.A shows any earnest money amount, and hand-editable in the workspace. NOT proof of receipt — never use it to suppress a delivery reminder. Use earnest_money_confirmed_at.';

COMMENT ON COLUMN public.transactions.earnest_money_confirmed_at IS
  'TREC ¶5.A earnest money CONFIRMED RECEIPT: written from the page-11 escrow receipt block of the executed contract, or set explicitly when title confirms. The only field that may suppress the earnest-money delivery reminder. NULL means not confirmed — remind.';
