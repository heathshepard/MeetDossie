-- ============================================================================
-- self_improvement_candidates.category — daily-cadence cleanup
--
-- Ridge, 2026-07-01 (follow-up to 20260701_self_improvement_signals.sql).
--
-- Heath 2026-07-01 07:18 CDT:
--   "I think i want it more daily. I dont want you to grow weekly but daily."
--
-- The daily cron now runs all three checks (conversation review, capability
-- scan, rule audit) in one 5 AM tick. The 6 AM digest shows the top 3
-- candidates PER CATEGORY. That grouping needs a stable column, not string
-- matching on `title`.
--
-- Safe to run twice; safe to run before or after the daily cron redeploys
-- (the cron falls back to inserting without the column when 400/422 comes
-- back from PostgREST).
-- ============================================================================

ALTER TABLE public.self_improvement_candidates
  ADD COLUMN IF NOT EXISTS category TEXT
    CHECK (category IN ('conversation_review','capability_scan','rule_audit') OR category IS NULL);

CREATE INDEX IF NOT EXISTS idx_self_improvement_candidates_category
  ON public.self_improvement_candidates (category, heath_decision, impact_score DESC);

COMMENT ON COLUMN public.self_improvement_candidates.category IS
  'Which of the three daily checks produced this candidate. Nullable for pre-daily-cadence rows.';
