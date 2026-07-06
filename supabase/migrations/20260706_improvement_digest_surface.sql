-- =============================================================================
-- SV-ENG-ATLAS-IMPROVEMENT-DIGEST-SURFACE-001 (Atlas, 2026-07-06)
--
-- Adds two things for the self-improvement approval-capture + apply loop:
--
--   1. `improvement_digest_surfaces` — records the ordered list of candidate
--      UUIDs shown in the most recent daily digest, keyed by chat_id +
--      surfaced_at. Heath's Telegram reply ("approve 1", "defer 3") is parsed
--      by mapping the integer to the row in `candidate_ids[]`.
--
--   2. Two new columns on `self_improvement_candidates`:
--        heath_decision_source TEXT   — 'telegram', 'sql', 'ui', etc.
--        heath_decision_message_id BIG — Telegram message id that captured it
--      (idempotency + audit trail for future incidents.)
--
-- Safe to run multiple times: IF NOT EXISTS everywhere.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.improvement_digest_surfaces (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  surfaced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  chat_id        TEXT NOT NULL,
  candidate_ids  UUID[] NOT NULL,
  message_id     BIGINT,             -- Telegram message_id of the digest, if we can get it
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_improvement_digest_surfaces_chat_time
  ON public.improvement_digest_surfaces (chat_id, surfaced_at DESC);

COMMENT ON TABLE public.improvement_digest_surfaces IS
  'One row per daily digest telegram send. candidate_ids[i-1] maps to the number Heath sees at position i. Approval webhook looks up the most recent row within 48h.';

ALTER TABLE public.self_improvement_candidates
  ADD COLUMN IF NOT EXISTS heath_decision_source TEXT,
  ADD COLUMN IF NOT EXISTS heath_decision_message_id BIGINT;

COMMENT ON COLUMN public.self_improvement_candidates.heath_decision_source IS
  'Where the decision came from: telegram, sql, ui-dashboard, etc.';

COMMENT ON COLUMN public.self_improvement_candidates.heath_decision_message_id IS
  'Telegram message id of the reply that captured the decision (audit trail).';
