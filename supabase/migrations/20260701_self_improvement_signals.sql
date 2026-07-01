-- ============================================================================
-- self_improvement_signals + self_improvement_candidates
--
-- Ridge, 2026-07-01 — Self-improvement meta-loop persistence.
--
-- Heath 2026-07-01 07:11 CDT:
--   "I want you to constantly think of ways to improve your intelligence and
--    usefullness to me. How do we make this a constant and ongoing pursuit."
--
-- The meta-loop has three tiers, each writing here:
--
--   Tier 1 (daily 5 AM CST, cron-self-improvement-daily.js)
--     Scans yesterday's Telegram conversations + agent_queue completions +
--     autonomous_loop_runs. Detects patterns:
--       - Heath corrections ("no", "stop", "don't", "you should have")
--       - Heath frustrations ("slow", "too technical", "too many questions")
--       - Cole punts ("I don't have access", "can you check", "want me to")
--       - Cole permission-asks for obviously-in-scope work
--     Every detected pattern → one signal row here.
--     Every proposed rule/change → one candidate row here.
--     Top 3 candidates surface in the 6 AM autonomous digest.
--
--   Tier 2 (weekly Sunday 6 AM CST, cron-self-improvement-weekly.js)
--     Scans MCP tool releases (Zapier catalog + registry), cross-references
--     with recent tasks, drafts capability-addition candidates.
--
--   Tier 3 (monthly 1st @ 8 AM CST, cron-self-improvement-monthly.js)
--     Reads all memory rules created that month, all agent prompts, all
--     daily digests. Identifies contradicted / dead / duplicate rules,
--     drafts consolidations / retirements / rewrites.
--
-- Nothing here auto-modifies memory or agent files. Every candidate ships
-- to Heath's daily brief for yes/no. Heath's response is logged in
-- `heath_decision` + `heath_decided_at` for meta-audit.
-- ============================================================================

-- ─── self_improvement_signals ────────────────────────────────────────────────
-- Raw pattern detections. One row per detected event.

CREATE TABLE IF NOT EXISTS public.self_improvement_signals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tier              TEXT NOT NULL CHECK (tier IN ('daily','weekly','monthly')),

  -- What we saw
  signal_kind       TEXT NOT NULL,
  -- daily:   'heath_correction' | 'heath_frustration' | 'cole_punt'
  --        | 'cole_permission_ask' | 'agent_correction_needed'
  --        | 'agent_completion_ok' | 'repeat_theme'
  -- weekly:  'new_zapier_action' | 'new_mcp_capability' | 'tool_gap'
  -- monthly: 'rule_contradicted' | 'rule_never_fired' | 'rule_duplicate'
  --        | 'agent_prompt_led_to_ship_broken' | 'repeat_correction_theme'

  source            TEXT,          -- 'telegram' | 'agent_queue' | 'autonomous_loop_runs'
                                    -- | 'zapier_catalog' | 'memory_scan' | 'agent_prompt_scan'
  source_id         TEXT,          -- pointer back to source row (message_id / queue_id / rule path)

  -- Verbatim evidence
  verbatim_quote    TEXT,          -- Heath's own words when available
  context_before    TEXT,          -- ~200 chars of what came before, for meaning
  context_after     TEXT,          -- ~200 chars of what came after

  -- Interpretation
  theme             TEXT,          -- 'brevity' | 'permission_asking' | 'punt' | ...
  severity          INT NOT NULL DEFAULT 3 CHECK (severity BETWEEN 1 AND 5),
                                    -- 1 = noted, 5 = repeated / structural

  notes             TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_self_improvement_signals_detected
  ON public.self_improvement_signals (detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_self_improvement_signals_theme
  ON public.self_improvement_signals (theme, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_self_improvement_signals_kind
  ON public.self_improvement_signals (signal_kind, detected_at DESC);

COMMENT ON TABLE public.self_improvement_signals IS
  'Raw pattern detections from the self-improvement meta-loop. Never mutated after insert. Rolled up into self_improvement_candidates for Heath review.';

ALTER TABLE public.self_improvement_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_self_improvement_signals"
  ON public.self_improvement_signals
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ─── self_improvement_candidates ─────────────────────────────────────────────
-- Human-reviewable proposals. Each candidate rolls up 1+ signals and drafts a
-- concrete change (new memory rule, retire rule, enable Zapier action, ...).

CREATE TABLE IF NOT EXISTS public.self_improvement_candidates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drafted_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tier                  TEXT NOT NULL CHECK (tier IN ('daily','weekly','monthly')),

  -- What kind of change
  change_kind           TEXT NOT NULL,
  -- 'new_memory_rule' | 'retire_memory_rule' | 'rewrite_memory_rule'
  -- | 'enable_zapier_action' | 'build_custom_integration'
  -- | 'rewrite_agent_prompt' | 'consolidate_rules'

  -- Human-readable summary
  title                 TEXT NOT NULL,        -- 1 line, brief-safe
  rationale             TEXT NOT NULL,        -- why this candidate exists
  proposed_change       TEXT NOT NULL,        -- exact rule text / exact action to take
  target_path           TEXT,                 -- where the change lands (memory file / agent md / vercel.json)
  supporting_quote      TEXT,                 -- Heath's own words, when we have them

  -- Roll-up
  signal_ids            UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  signal_count          INT NOT NULL DEFAULT 1,

  -- Scoring — how much this would move the needle. Top 3 by score/day → daily brief.
  impact_score          INT NOT NULL DEFAULT 3 CHECK (impact_score BETWEEN 1 AND 10),

  -- Heath review
  surfaced_in_brief_at  TIMESTAMPTZ,          -- when candidate first appeared in a digest
  heath_decision        TEXT CHECK (heath_decision IN ('approved','rejected','deferred','superseded') OR heath_decision IS NULL),
  heath_decided_at      TIMESTAMPTZ,
  heath_note            TEXT,

  -- Post-decision
  applied_at            TIMESTAMPTZ,          -- when Ridge actually wrote the change
  applied_commit_sha    TEXT,
  applied_notes         TEXT,

  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_self_improvement_candidates_drafted
  ON public.self_improvement_candidates (drafted_at DESC);

CREATE INDEX IF NOT EXISTS idx_self_improvement_candidates_pending
  ON public.self_improvement_candidates (drafted_at DESC)
  WHERE heath_decision IS NULL;

CREATE INDEX IF NOT EXISTS idx_self_improvement_candidates_tier
  ON public.self_improvement_candidates (tier, drafted_at DESC);

COMMENT ON TABLE public.self_improvement_candidates IS
  'Concrete change proposals from the self-improvement meta-loop. Surfaced in Heath''s 6 AM brief. NOT auto-applied — Heath approves in the daily reply.';

ALTER TABLE public.self_improvement_candidates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_self_improvement_candidates"
  ON public.self_improvement_candidates
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ─── self_improvement_runs ───────────────────────────────────────────────────
-- One row per meta-loop tick, so we can prove the loop actually fired daily,
-- weekly, monthly. Ridge reliability instinct: measure the measurer.

CREATE TABLE IF NOT EXISTS public.self_improvement_runs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_ts                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tier                  TEXT NOT NULL CHECK (tier IN ('daily','weekly','monthly')),

  -- What the tick did
  signals_scanned       INT NOT NULL DEFAULT 0,
  signals_recorded      INT NOT NULL DEFAULT 0,
  candidates_drafted    INT NOT NULL DEFAULT 0,

  outcome               TEXT NOT NULL,   -- 'ok' | 'no_data' | 'error'
  outcome_reason        TEXT,
  duration_ms           INT,

  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_self_improvement_runs_ts
  ON public.self_improvement_runs (run_ts DESC);

CREATE INDEX IF NOT EXISTS idx_self_improvement_runs_tier
  ON public.self_improvement_runs (tier, run_ts DESC);

COMMENT ON TABLE public.self_improvement_runs IS
  'One row per self-improvement cron tick. Confirms the meta-loop actually fired. Read by cron-mission-watchdog for alerting.';

ALTER TABLE public.self_improvement_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_self_improvement_runs"
  ON public.self_improvement_runs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
