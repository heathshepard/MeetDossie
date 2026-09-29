-- 20260916c_auto_reply_model_verdict.sql
--
-- The risk classifier for auto-reply-with-veto (scripts/_lib/
-- auto-reply-risk-classifier.js) is now a Claude Haiku 4.5 call, not a
-- pattern engine (Carter, 2026-09-16, 3rd QA-round rewrite — a fixed regex
-- list kept losing to genuinely semantic categories: named third parties
-- and comparative/implied pricing take unbounded surface forms). Every
-- verdict needs to be diagnosable later, so this adds the model's own
-- confidence and one-line reason, plus which code path produced the
-- verdict (the tiny hard pre-filter, a real model call, or a fail-closed
-- error path) — auto_reply_eligible/auto_reply_category already exist
-- from 20260916_auto_reply_veto.sql.
--
-- Owner: Carter, 2026-09-16

ALTER TABLE public.tc_discovery_responses
  ADD COLUMN IF NOT EXISTS auto_reply_confidence TEXT
    CHECK (auto_reply_confidence IN ('high','medium','low') OR auto_reply_confidence IS NULL),
  ADD COLUMN IF NOT EXISTS auto_reply_reason TEXT,
  ADD COLUMN IF NOT EXISTS auto_reply_source TEXT
    CHECK (auto_reply_source IN ('pre_filter','model','model_error') OR auto_reply_source IS NULL);

COMMENT ON COLUMN public.tc_discovery_responses.auto_reply_confidence IS
  'Confidence the classifier (pre-filter or model) attached to its verdict. eligible=true only ever survives to auto_reply_eligible when this is "high" — see classifyCommentRisk() in scripts/_lib/auto-reply-risk-classifier.js.';
COMMENT ON COLUMN public.tc_discovery_responses.auto_reply_reason IS
  'One-line human-readable reason from the classifier (the model''s own explanation, or the specific pre-filter/fail-closed path that fired). Read this before trusting or disputing any auto_reply_category value.';
COMMENT ON COLUMN public.tc_discovery_responses.auto_reply_source IS
  'Which code path produced the verdict: pre_filter (hard $-figure/demo-word match, never eligible), model (a real Claude Haiku 4.5 classification), or model_error (API key missing, network/timeout failure, or a malformed/unparseable response — always eligible=false, fail-closed).';
