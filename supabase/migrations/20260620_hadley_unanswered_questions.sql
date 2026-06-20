-- =============================================================================
-- Ask Hadley: Unanswered Questions Tracking
-- Author: Carter (draft) + Atlas (ship fixes)
-- Date: 2026-06-20
-- Purpose: Track questions the knowledge base couldn't answer, for Hadley's
--          next study pass. Enables continuous learning loop.
--
-- Idempotent: re-runnable. All CREATEs guarded.
-- Note: api/ask-hadley.js inserts via service role, which bypasses RLS. RLS
--       below is a defense-in-depth layer for any future client-direct read.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.hadley_unanswered_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  form_context TEXT,                                       -- e.g. "TREC 20-18 12.A.(1)(b)"
  asked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  answered_at TIMESTAMP WITH TIME ZONE,                    -- Filled by Hadley post-research
  hadley_answer TEXT,                                      -- Hadley's follow-up answer
  study_session_id UUID,                                   -- Batch of answers from one study pass
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.hadley_unanswered_questions ENABLE ROW LEVEL SECURITY;

-- Customers can read their own logged questions
DROP POLICY IF EXISTS hadley_unanswered_read_own ON public.hadley_unanswered_questions;
CREATE POLICY hadley_unanswered_read_own ON public.hadley_unanswered_questions
  FOR SELECT
  USING (customer_user_id = auth.uid());

-- Founders (Heath, etc.) can read everything
DROP POLICY IF EXISTS hadley_unanswered_founder_all ON public.hadley_unanswered_questions;
CREATE POLICY hadley_unanswered_founder_all ON public.hadley_unanswered_questions
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.is_founder = true
    )
  );

-- Indexes (idempotent)
CREATE INDEX IF NOT EXISTS hadley_unanswered_by_user
  ON public.hadley_unanswered_questions(customer_user_id, answered_at);

CREATE INDEX IF NOT EXISTS hadley_unanswered_by_session
  ON public.hadley_unanswered_questions(study_session_id);

CREATE INDEX IF NOT EXISTS hadley_unanswered_asked_at
  ON public.hadley_unanswered_questions(asked_at DESC);
