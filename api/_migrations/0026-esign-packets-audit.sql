-- 0026-esign-packets-audit.sql
-- 2026-09-08 CARTER — multi-document packets + the e-sign audit trail
-- (docs/DOSSIE-DOCUSEAL-INTEGRATION-PLAN-2026-09-01.md §2.2 + §3).
--
-- Run in the Supabase SQL editor. Purely additive; no data mutation.
--
-- signature_requests gains:
--   document_ids          JSONB   — packet document uuids in send order
--                                   (document_id keeps the first/primary doc
--                                   for legacy readers)
--   sent_pdf_sha256       JSONB   — { documentId: sha256 } of the exact bytes
--                                   sent for signing
--   signed_pdf_sha256     JSONB   — { fileName: sha256 } of the signed PDFs
--                                   that came back on completion
--   audit_log_sha256      TEXT    — sha256 of DocuSeal's completion
--                                   certificate PDF (audit_log_url)
--   audit_log_document_id UUID    — documents row storing our copy of the
--                                   completion certificate
--   submission_events     JSONB   — snapshot of DocuSeal submission_events
--                                   (who opened/signed what, when; carries
--                                   timestamps + whatever DocuSeal provides)
--   docuseal_template_id  TEXT    — transient template id (future reaper)
--   audit_fetch_failed_at TIMESTAMPTZ — set when the completion-leg audit
--                                   fetch failed; cron backfill retries these

ALTER TABLE public.signature_requests
  ADD COLUMN IF NOT EXISTS document_ids          JSONB,
  ADD COLUMN IF NOT EXISTS sent_pdf_sha256       JSONB,
  ADD COLUMN IF NOT EXISTS signed_pdf_sha256     JSONB,
  ADD COLUMN IF NOT EXISTS audit_log_sha256      TEXT,
  ADD COLUMN IF NOT EXISTS audit_log_document_id UUID REFERENCES public.documents(id),
  ADD COLUMN IF NOT EXISTS submission_events     JSONB,
  ADD COLUMN IF NOT EXISTS docuseal_template_id  TEXT,
  ADD COLUMN IF NOT EXISTS audit_fetch_failed_at TIMESTAMPTZ;
