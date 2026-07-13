-- 20260713_contract_field_drafts.sql
--
-- Bug #2 fix (Quinn DoD Round 1, 2026-07-13).
--
-- Interactive Editor persistence gap: only ~30 of the ~200 TREC 20-19 fields
-- have a home on the canonical `transactions` row. The other ~170 were being
-- returned as {ok: true, skipped: true} — UI showed "Saved" but the values
-- were dropped. On reload the editor wiped 170 fields.
--
-- Fix: add a JSONB column keyed by form_number → { field_key: value } so
-- non-canonical fields persist across sessions.
--
-- Shape:
--   contract_field_drafts = {
--     "20-19": { "buyer_agent_email": "...", "escrow_id": "...", ... },
--     "40-11": { ... }
--   }
--
-- CARTER draft 2026-07-13. Atlas applies during ship.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS contract_field_drafts JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.transactions.contract_field_drafts IS
  'Interactive Editor drafts keyed by form_number → { field_key: value } for fields not modeled as canonical transactions columns.';
