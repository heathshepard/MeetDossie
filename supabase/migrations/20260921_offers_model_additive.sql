-- ============================================================================
-- Offers model, additive pieces (item 2 of the coordinator-approved plan,
-- 2026-09-21). Schema only — no revert logic, no backfill. Extends
-- transaction_offers rather than forking a new "offer" entity: a second
-- table claiming to be "the offer" is how log_offer became a dead tool.
--
-- Live DDL for transaction_offers was pulled via the PostgREST OpenAPI
-- introspection endpoint (SUPABASE_URL/rest/v1/ with Accept:
-- application/openapi+json) before writing this — no migration file existed
-- for that table's original creation, so this was the only way to confirm
-- real column names/types rather than guess. Confirmed: id, transaction_id
-- (FK -> transactions.id), user_id, buyer_name, offer_price, financing_type,
-- down_payment_pct, option_fee, option_days, earnest_money, closing_date,
-- escalation_clause, escalation_cap, notes, submitted_at, status (default
-- 'pending', text, no DB-level CHECK constraint found — status is validated
-- in api/transaction-offers.js's VALID_STATUSES set, which is where
-- 'retired' gets added alongside this migration).
--
-- SCOPE CORRECTION found while pulling live DDL: the design doc named 6
-- flat transactions columns for Rule C (sale_price, contract_effective_date,
-- closing_date, option_fee, option_days, earnest_money). The live schema has
-- 17. A DB trigger (trg_transactions_funds_due_dates, see
-- funds-due-dates-trigger-sql.js) auto-derives option_fee_due_date and
-- earnest_money_due_date from contract_effective_date on every INSERT/UPDATE
-- OF contract_effective_date -- UNLESS the same statement explicitly sets
-- those two columns, in which case the caller's value wins (NEW IS NOT
-- DISTINCT FROM OLD precedence rule). A Rule C revert that only restores the
-- original 6 fields and lets the trigger recompute the due-dates from the
-- reverted effective date would silently leave earnest_money_confirmed_at,
-- option_fee_confirmed_at, earnest_money_deposited_at, option_fee_paid_at/
-- _paid_to, earnest_money_title_company, and option_expiration_date/
-- option_fee_amount/earnest_money_amount stale -- a half-reverted deal with
-- live deadlines, which is the exact failure mode called out for this work.
-- offer_field_snapshots below is deliberately schema-free on field_name (no
-- CHECK/enum) so the snapshot set can be the full 17-field list the revert
-- step needs without a second migration -- the allowlist lives in
-- application code (api/_lib/offer-field-snapshots.js), same pattern as
-- contract-term-persistence.js's TERM_FIELD_MAP.
--
-- Owner: Carter, 2026-09-21.
-- ============================================================================

-- --- transaction_offers: retirement + acceptance-linkage columns ----------

ALTER TABLE public.transaction_offers
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retired_reason TEXT,
  ADD COLUMN IF NOT EXISTS applied_to_transaction_at TIMESTAMPTZ;

COMMENT ON COLUMN public.transaction_offers.accepted_at IS
  'When this offer''s status became ''accepted'' AND its terms were copied onto transactions (see applied_to_transaction_at -- same moment, kept as two columns because a future accept path could theoretically decouple them).';
COMMENT ON COLUMN public.transaction_offers.retired_at IS
  'When an ACCEPTED offer later fell through (buyer terminated, financing failed, etc). Status moves to ''retired'', never deleted -- Rule A. NULL for every offer that was never accepted, and for the currently-live accepted offer.';
COMMENT ON COLUMN public.transaction_offers.retired_reason IS
  'Free text, e.g. "buyer terminated during option period", "financing fell through". Set alongside retired_at.';
COMMENT ON COLUMN public.transaction_offers.applied_to_transaction_at IS
  'The moment this offer''s terms were written onto the parent transactions row''s flat columns. This is the missing link the pre-2026-09-21 accept flow never recorded -- without it there is no way to know which offer_field_snapshots rows belong to the CURRENTLY-live acceptance vs a prior, already-retired one.';

CREATE INDEX IF NOT EXISTS transaction_offers_status_idx ON public.transaction_offers (status);

-- --- offer_field_snapshots --------------------------------------------------
-- One row per transactions column touched, per offer-acceptance event. This
-- is Rule C's revert mechanism: "revert" = look up the most recent snapshot
-- rows for the CURRENTLY-accepted offer (applied_to_transaction_at not yet
-- superseded by a later acceptance), write prior_value back onto
-- transactions for each field in ONE atomic statement (so the funds-due-date
-- trigger's precedence rule sees every value as caller-supplied), then flip
-- transaction_offers.status to 'retired'.
--
-- prior_value / new_value are stored as TEXT deliberately -- the 17-field
-- allowlist spans numeric, date, timestamptz, and text columns, and a single
-- typed column per row would need a second table per type. The revert step
-- casts back to the destination column's real type; the allowlist + casting
-- rules live in api/_lib/offer-field-snapshots.js, not the DB.

CREATE TABLE IF NOT EXISTS public.offer_field_snapshots (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id       UUID NOT NULL REFERENCES public.transaction_offers(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  field_name     TEXT NOT NULL,
  prior_value    TEXT,
  new_value      TEXT
);

CREATE INDEX IF NOT EXISTS offer_field_snapshots_offer_idx ON public.offer_field_snapshots (offer_id);
CREATE INDEX IF NOT EXISTS offer_field_snapshots_transaction_idx ON public.offer_field_snapshots (transaction_id, captured_at DESC);

ALTER TABLE public.offer_field_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_read" ON public.offer_field_snapshots;
CREATE POLICY "owner_read"   ON public.offer_field_snapshots
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "service_all" ON public.offer_field_snapshots;
CREATE POLICY "service_all"  ON public.offer_field_snapshots
  FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE public.offer_field_snapshots IS
  'Rule C revert mechanism: per-field before/after values captured the moment an offer''s terms are copied onto transactions. No client/service write path exists yet in this migration -- that ships in the next commit (the atomic revert step), tested against a two-accepted-offer chain before anything reads from this table in production.';

-- --- document_offer_links ---------------------------------------------------
-- Many-to-many: a document belongs to the specific offer whose paper trail
-- it's part of (executed contract, amendment, addendum tied to one buyer's
-- offer). Property-level documents (survey, seller's disclosure, HOA docs,
-- T-47 -- the same set DOCUMENT_TYPE_META already classifies as property-
-- level in the Dossie repo) simply have NO row here. The absence of a link
-- is what makes them survive every offer by construction, not a flag that
-- has to be set correctly on every document.

CREATE TABLE IF NOT EXISTS public.document_offer_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  offer_id    UUID NOT NULL REFERENCES public.transaction_offers(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, offer_id)
);

CREATE INDEX IF NOT EXISTS document_offer_links_document_idx ON public.document_offer_links (document_id);
CREATE INDEX IF NOT EXISTS document_offer_links_offer_idx ON public.document_offer_links (offer_id);

ALTER TABLE public.document_offer_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_read" ON public.document_offer_links;
CREATE POLICY "owner_read"   ON public.document_offer_links
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "service_all" ON public.document_offer_links;
CREATE POLICY "service_all"  ON public.document_offer_links
  FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE public.document_offer_links IS
  'Which documents belong to which offer''s paper trail. No rows are written by this migration -- population starts with the backfill step (last in the coordinator-approved sequence) for existing dossiers, and going forward at upload/link time once the accept flow uses this table.';
