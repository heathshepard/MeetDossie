-- signature_requests.suppress_notifications
--
-- 2026-09-17 — C1 write-back (docs/BACKLOG-ENGINEERING.md).
--
-- WHY THIS COLUMN EXISTS
-- ----------------------
-- scripts/send-trec-amendment.js is the CLI fast path Heath uses to send real
-- TREC amendments to real clients. Until now it wrote nothing back to Supabase,
-- so the verification/certificate leg never saw a real completion.
--
-- Making that script insert a signature_requests row is the fix — but the row is
-- what api/esign-webhook.js keys on, and its form.completed branch does two very
-- different things:
--
--   (a) AUDIT  — download every signed PDF + DocuSeal's completion certificate,
--                sha256 them, snapshot submission_events, mark the row completed.
--                This is the capability we want fed.
--
--   (b) NOTIFY — email the owner, email EVERY SIGNER, email the seller's agent.
--
-- (b) is correct when a Dossie member sends through the product: Dossie owns the
-- whole conversation. It is WRONG for the CLI path, where DocuSeal has already
-- emailed the signers directly (send_email: true) and the signers are Heath's
-- own clients on a live transaction. Inserting an unflagged row would have
-- silently started sending real clients a second, unrequested "Your signed
-- contract" email from sign@meetdossie.com the next time Heath used the script.
--
-- So: tracking rows created outside the product UI set this flag, and the
-- webhook runs (a) and skips (b).
--
-- DEFAULT false — every existing row and every row api/esign-create.js writes
-- keeps exactly today's behavior. This migration changes nothing on its own.

ALTER TABLE public.signature_requests
  ADD COLUMN IF NOT EXISTS suppress_notifications boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.signature_requests.suppress_notifications IS
  'True for tracking-only rows (CLI sends via scripts/send-trec-amendment.js, '
  'backfills via scripts/backfill-docuseal-completions.js). api/esign-webhook.js '
  'still stores signed PDFs, the completion certificate, hashes and events, but '
  'sends no owner / signer / seller-agent email. DocuSeal already emailed those '
  'signers directly. Default false = unchanged product behavior.';
