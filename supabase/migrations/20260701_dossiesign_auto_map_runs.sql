-- Supabase migration: dossiesign_auto_map_runs table
-- Stores Fable 5 auto-mapping job history, field maps, and QA status.
-- Created: 2026-07-01

CREATE TABLE IF NOT EXISTS public.dossiesign_auto_map_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now() NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE CASCADE,

  -- PDF source
  pdf_url text NOT NULL,
  pdf_hash text NOT NULL,
  doc_name text,
  vertical text,
  requested_form_number text,

  -- Fable 5 output
  page_count integer,
  field_count integer,
  fields jsonb,
  model_used text DEFAULT 'claude-fable-5',
  model_cost_cents integer,

  -- QA tracking
  qa_status text DEFAULT 'pending',
  qa_notes text,
  qa_reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  qa_reviewed_at timestamptz,

  -- Downstream DocuSeal integration
  template_id text,
  preview_png_url text,

  CONSTRAINT pdf_hash_unique UNIQUE (pdf_hash, created_by),
  CONSTRAINT valid_qa_status CHECK (qa_status IN ('pending', 'awaiting_hadley_qa', 'approved', 'rejected', 'revise_requested')),
  CONSTRAINT valid_vertical CHECK (vertical IS NULL OR vertical IN ('residential', 'land', 'rental', 'commercial', 'other'))
);

CREATE INDEX idx_dossiesign_auto_map_runs_created_by ON public.dossiesign_auto_map_runs(created_by);
CREATE INDEX idx_dossiesign_auto_map_runs_qa_status ON public.dossiesign_auto_map_runs(qa_status);
CREATE INDEX idx_dossiesign_auto_map_runs_template_id ON public.dossiesign_auto_map_runs(template_id);
CREATE INDEX idx_dossiesign_auto_map_runs_created_at ON public.dossiesign_auto_map_runs(created_at DESC);
