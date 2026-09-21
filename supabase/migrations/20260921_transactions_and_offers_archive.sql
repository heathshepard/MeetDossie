-- ============================================================================
-- transactions.archived_at + transaction_offers.archived_at — "delete" a
-- dossier or an offer without destroying it.
--
-- Coordinator, 2026-09-21, after the hard-delete sibling audit: "This is the
-- biggest exposure in the app and it's reachable from a button labelled
-- 'Permanently delete' on Closed Dossiers. One click destroys Storage
-- objects, documents, emails, offers, signature requests, amendments,
-- wire-fraud deliveries and deadline reminders for a closed deal — a
-- client's entire transaction record, with no archive step. Heath is a
-- licensed agent with record-retention obligations; that button is a
-- licence problem, not just a data problem."
--
-- Before this, DELETE /api/transactions hard-deleted the transaction row
-- (CASCADE destroying signature_requests, amendments, wire_fraud_deliveries,
-- deadline_reminders, transaction_offers) plus its documents (+ Storage
-- objects), action_items, and email_queue rows outright. This is the
-- additive, reversible replacement, same pattern as documents.archived_at
-- (20260921_documents_archive.sql): a NULL archived_at is an active/visible
-- row (current behavior, unchanged); a timestamp is "removed from the
-- working view, still on the record." Nothing under an archived transaction
-- is separately touched — the parent being hidden is what hides the file;
-- child rows (documents, action_items, email_queue, transaction_offers,
-- etc.) are left exactly as they were.
--
-- DELETE /api/transaction-offers hard-deleted an individual offer-comparison
-- row outright. Same fix, same reasoning, smaller blast radius.
--
-- Owner: Carter, 2026-09-21.
-- ============================================================================

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

COMMENT ON COLUMN public.transactions.archived_at IS
  'When this dossier was archived (soft-deleted). NULL = active/visible. Set by DELETE /api/transactions, which stopped hard-deleting the row (and cascading to its documents/action_items/email_queue/signature_requests/amendments/wire_fraud_deliveries/deadline_reminders/transaction_offers) on 2026-09-21 — archiving is the only "delete" path now.';

CREATE INDEX IF NOT EXISTS transactions_archived_at_idx ON public.transactions (archived_at);

ALTER TABLE public.transaction_offers
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

COMMENT ON COLUMN public.transaction_offers.archived_at IS
  'When this offer-comparison row was archived (soft-deleted) by the member removing it from the table. NULL = active/visible. Distinct from the offers-model "retired" status (an offer that was accepted then fell through) — that is a live business-state transition tracked separately, not a member delete action.';

CREATE INDEX IF NOT EXISTS transaction_offers_archived_at_idx ON public.transaction_offers (archived_at);
