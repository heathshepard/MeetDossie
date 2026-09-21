-- ============================================================================
-- wire_fraud_deliveries.recipient_role — TAR/TXR 2517 is buyer AND seller
-- facing, not buyer-only.
--
-- Heath's executed copy: "Buyers and Sellers Beware: Criminals are
-- targeting real estate transactions," with a [ ] Seller [ ] Buyer
-- checkbox pair — his copy has Seller checked for both parties on 23
-- Nopalito. Dossie told him this morning that the form was buyer-facing
-- and declined to send it to his sellers — confident, plausible, wrong.
-- The chat tool description, prompt guidance, and this table's own
-- buyer_name/buyer_email-only columns all asserted the same wrong
-- assumption in three different places.
--
-- This column doesn't rename buyer_name/buyer_email (both writers —
-- fill-form.js's DocuSeal path and the new wire-fraud-mark-sent.js manual
-- path — still use them as the generic "recipient" name/email pair,
-- documented as such in both files now) — it records WHICH party a
-- delivery actually covers, so a listing-side seller's wire-fraud warning
-- can be tracked honestly instead of being invisible to a table whose
-- column names implied "buyer only."
--
-- NULL = legacy rows written before this column existed, or a delivery
-- whose role was never recorded — treated as unknown, not assumed buyer.
--
-- Owner: Carter, 2026-09-21.
-- ============================================================================

ALTER TABLE public.wire_fraud_deliveries
  ADD COLUMN IF NOT EXISTS recipient_role TEXT;

COMMENT ON COLUMN public.wire_fraud_deliveries.recipient_role IS
  'Which party this wire-fraud-warning delivery covers: buyer or seller. TAR/TXR 2517 applies to both. NULL on legacy rows written before this column existed.';
