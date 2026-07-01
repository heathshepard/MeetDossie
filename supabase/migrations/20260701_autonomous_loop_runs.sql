-- ============================================================================
-- autonomous_loop_runs + autonomous_loop_signals_seen
--
-- Ridge, 2026-07-01 — Self-improvement loop persistence.
--
-- Every 4 hours cron-autonomous-loop.js:
--   1. Gathers signals (customer bugs, prod errors, KPI drift, tech debt,
--      Dossie Sign last-mile blockers, agent backlogs)
--   2. Picks THE ONE highest-priority item
--   3. Dispatches to the right agent via agent_queue
--   4. Writes a row here so the daily digest + reliability dashboard can
--      surface what happened
--
-- autonomous_loop_signals_seen prevents the loop from picking the same signal
-- across two consecutive runs. Once a signal is picked, its "signal_key" is
-- stored with a TTL of 24h (cooldown). Refill happens naturally as the picker
-- either resolves the signal or the cooldown expires.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.autonomous_loop_runs (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_ts                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- What signal drove this run
  signal_source          TEXT NOT NULL,   -- 'customer_bug' | 'prod_error' | 'kpi_drift'
                                          -- | 'tech_debt' | 'dossie_sign_lastmile'
                                          -- | 'sage_backlog' | 'hadley_backlog'
                                          -- | 'pierce_backlog' | 'no_signal'
  signal_key             TEXT,            -- dedupe key (ticket_id, cron_name, kpi name, etc.)
  signal_score           NUMERIC,         -- computed priority points (higher = more urgent)
  signal_snapshot        JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- What we picked to work on
  item_picked            TEXT,            -- human-readable summary of the item
  item_details           JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Who we dispatched to
  agent_dispatched       TEXT,            -- 'carter' | 'atlas' | 'hadley' | ...
  queue_id               UUID,            -- FK to agent_queue.id (soft — no fk constraint
                                          -- to avoid coupling)
  future_build_id        UUID,            -- FK to jarvis_future_builds.id (soft)

  -- Outcome
  outcome                TEXT NOT NULL,   -- 'dispatched' | 'skipped_no_signal'
                                          -- | 'skipped_cooldown' | 'skipped_guardrail'
                                          -- | 'skipped_stuck'     | 'error'
  outcome_reason         TEXT,            -- why we skipped (if skipped)
  ship_commit_sha        TEXT,            -- filled by post-hoc reconciliation
                                          -- (daily digest matches queue completion → sha)
  duration_ms            INTEGER,

  notes                  TEXT,
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_autonomous_loop_runs_ts
  ON public.autonomous_loop_runs (run_ts DESC);

CREATE INDEX IF NOT EXISTS idx_autonomous_loop_runs_outcome
  ON public.autonomous_loop_runs (outcome, run_ts DESC);

CREATE INDEX IF NOT EXISTS idx_autonomous_loop_runs_queue
  ON public.autonomous_loop_runs (queue_id)
  WHERE queue_id IS NOT NULL;

COMMENT ON TABLE public.autonomous_loop_runs IS
  'One row per 4h autonomous loop tick. Signal in, dispatch out. Daily digest reads this.';

-- RLS: service role only
ALTER TABLE public.autonomous_loop_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_autonomous_loop_runs"
  ON public.autonomous_loop_runs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ────────────────────────────────────────────────────────────────────────────
-- Signal cooldown table — dedupe across runs
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.autonomous_loop_signals_seen (
  signal_key         TEXT PRIMARY KEY,     -- e.g. 'customer_bug:<ticket_id>'
                                           -- 'cron_error:<cron_name>'
                                           -- 'kpi_drift:mrr'
                                           -- 'dossie_sign:<md_path>#<blocker_idx>'
  signal_source      TEXT NOT NULL,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatch_count     INTEGER NOT NULL DEFAULT 1,
  cooldown_until     TIMESTAMPTZ NOT NULL,  -- until this time, do not re-pick
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_autonomous_loop_signals_seen_cooldown
  ON public.autonomous_loop_signals_seen (cooldown_until);

COMMENT ON TABLE public.autonomous_loop_signals_seen IS
  'Cooldown ledger — once a signal is dispatched, it will not be re-picked until cooldown_until. Prevents spawn-loop.';

ALTER TABLE public.autonomous_loop_signals_seen ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_autonomous_loop_signals"
  ON public.autonomous_loop_signals_seen
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
