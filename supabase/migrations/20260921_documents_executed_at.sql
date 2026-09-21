-- ============================================================================
-- documents.executed_at — separate "this copy is the executed/signed one"
-- from the document's real category.
--
-- Coordinator, 2026-09-21, on the 507 Ridge Blf backfill finding: "That's
-- worth fixing on its own merits, independent of the backfill — a signed
-- HOA addendum is still an HOA addendum, and losing that classification
-- degrades search, grouping and any future rule that keys off document
-- type. Do that next: preserve the real category alongside the executed
-- status rather than overwriting it."
--
-- Root cause: three write sites (api/esign-download.js, api/cron-esign-
-- events.js) file the completed signed PDF as a NEW documents row and set
-- document_type to the literal 'signed' — discarding whatever real category
-- (HOA addendum, amendment, financing addendum, ...) the original document
-- actually was. DOCUMENT_TYPE_META in dossie-app.jsx then buckets every one
-- of these into a generic "Signed/Executed" section with a generic label,
-- which is exactly the 507 Ridge Blf symptom: 11 documents, all typed
-- 'signed'/'signing_certificate', with no way to tell an amendment from a
-- termination notice from a price-change without opening each PDF.
--
-- Fix: api/esign-download.js now looks up the ORIGINAL document's real
-- document_type (via signature_requests.document_id, which it already
-- fetches the file_name from) and preserves it on the new signed-copy row,
-- setting executed_at instead of clobbering document_type. Section grouping
-- in the Dossie repo needs NO change — DOCUMENT_TYPE_META already routes a
-- preserved real type to its correct section; only the "Signed" tile badge
-- (which used to read document_type==='signed' as one of its two signals)
-- gains executed_at as a third, so nothing that already worked stops
-- working. api/cron-esign-events.js's Gmail-parsed completion path has no
-- structured link to an original document, so it still can't know the real
-- category — it keeps document_type='signed' there (the honest "unknown"
-- state) but now also sets executed_at for consistency.
--
-- NULL = not filed as an executed/signed copy through this pipeline
-- (unaffected — every existing document, manually-uploaded or otherwise).
--
-- Owner: Carter, 2026-09-21.
-- ============================================================================

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.documents.executed_at IS
  'When this row was filed as the completed/executed copy of a document sent for e-signature. NULL = not an e-sign-pipeline copy. Distinct from document_type, which (as of 2026-09-21) preserves the document''s real category where the source is known (api/esign-download.js) instead of being overwritten to the generic literal "signed".';

CREATE INDEX IF NOT EXISTS documents_executed_at_idx ON public.documents (executed_at);
