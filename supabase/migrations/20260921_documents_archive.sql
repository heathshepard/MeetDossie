-- ============================================================================
-- documents.archived_at — "delete" a document without destroying it.
--
-- Heath, on the document/offer model: "Nothing is ever destroyed. 'Delete'
-- means archive... He may have to prove what was in force on a given date."
--
-- Before this, DELETE /api/documents removed the Storage object AND the row
-- outright — a member's own client, still a dossier's record of what was
-- filed and when, gone permanently on one click and one confirm dialog. This
-- is the additive, reversible replacement: a NULL archived_at is an active
-- document (the current behavior, unchanged); a timestamp is "removed from
-- the working view, still on the record."
--
-- Deliberately NOT reusing the existing `status` column — that already means
-- something else (isBlankTemplateDoc checks status='blank' for a form
-- template placeholder in resolve-blank-template-pdf.js), and overloading it
-- would make "archived AND still a blank template" unrepresentable.
--
-- Owner: Carter, 2026-09-21.
-- ============================================================================

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

COMMENT ON COLUMN public.documents.archived_at IS
  'When this document was archived (soft-deleted). NULL = active/visible. Set by DELETE /api/documents, which stopped removing rows/Storage objects on 2026-09-21 — archiving is the only "delete" path now. The Storage object and the row are never removed by member action.';

CREATE INDEX IF NOT EXISTS documents_archived_at_idx ON public.documents (archived_at);
