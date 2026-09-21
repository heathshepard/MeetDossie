-- ============================================================================
-- member_form_templates — a member's own brokerage/standard forms, stored
-- once, attachable to any dossier.
--
-- Heath tried to add his KW City View CMA Acknowledgement under Settings ->
-- My Standard Documents and hit three problems: (1) the "Add" button looked
-- broken (disabled with no explanation until a name was typed), (2) the list
-- lived in localStorage only — lost on cache clear, absent on his phone,
-- invisible to Dossie server-side, (3) it only ever stored a CHECKLIST
-- LABEL, never the actual PDF, so Dossie still couldn't fill or send it —
-- the exact brokerage-forms gap that made her tell him it was impossible
-- that morning.
--
-- Heath's own simplification: "Let's just have the add a document open up a
-- file picker... they push that button, they expect a file picker to open
-- up." This table is what that file becomes. Mirrors form_packages.user_id
-- — already the correct, fully-wired-but-unused per-member ownership
-- pattern in this schema — rather than inventing a new one.
--
-- storage_path points into the SAME 'documents' Storage bucket, namespaced
-- under {user_id}/member-forms/ — no new bucket, no new RLS policy shape to
-- get right a second time.
--
-- Owner: Carter, 2026-09-21.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.member_form_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  description  TEXT,
  file_name    TEXT,
  file_type    TEXT,
  file_size    BIGINT,
  storage_path TEXT,
  -- NULL storage_path = a label carried over from the old localStorage-only
  -- flow with no real file yet attached (see the one-time client-side
  -- migration in dossie-app.jsx) — distinct from a genuine upload.
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS member_form_templates_user_idx ON public.member_form_templates (user_id, created_at DESC);

ALTER TABLE public.member_form_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_all" ON public.member_form_templates;
CREATE POLICY "owner_all" ON public.member_form_templates
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "service_all" ON public.member_form_templates;
CREATE POLICY "service_all" ON public.member_form_templates
  FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE public.member_form_templates IS
  'A member''s own brokerage/standard PDF forms — stored once, attachable and sendable on any dossier. Per-member, mirrors form_packages.user_id.';
