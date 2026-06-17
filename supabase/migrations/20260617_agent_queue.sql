-- ============================================================================
-- agent_queue + agent_state — autonomous agent orchestration
--
-- Purpose: Make the Shepard Ventures agent team never idle. Heath's directive:
--   "I do want my agents to constantly be working 24 on something. I never
--    want them idle. As soon as they get done with one task, they pick up
--    the next task."
--
-- Architecture:
--   - agent_queue holds pending work, one row per task. Cole/Jarvis (or the
--     orchestrator cron) populates it. Tasks carry priority + venture +
--     depends_on so we can pick the next sensible task per agent.
--   - agent_state holds one row per known agent — the source of truth for
--     "is this agent busy or free." Picker logic queries here.
--   - The execution-log table (agent_activity) is UNCHANGED. The queue is
--     planning + assignment. agent_activity stays the runtime log that
--     today.html / the Jarvis HUD reads from.
--
-- Picker flow (cron-agent-queue-tick OR local Cole poller):
--   1. For each agent_state row where status='idle' (or heartbeat stale),
--   2. Find the highest-priority pending agent_queue row for that agent
--      whose depends_on tasks are all status='completed',
--   3. Mark it status='in_progress', stamp started_at, set
--      agent_state.current_task_id and status='working',
--   4. Spawn the agent (server-side via Sonnet REST, OR the local Cole
--      session reads it from /api/agent-queue-claim and spawns locally).
--
-- Status state machine:
--   pending → in_progress → completed
--           ↘ cancelled
--   blocked is a separate terminal-for-now state (agent flagged a blocker,
--           Cole/Heath needs to intervene).
--
-- Owner: Atlas (SV-ENG-AGENT-QUEUE / 2026-06-17)
-- ============================================================================

-- ─── agent_queue ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_queue (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name                  TEXT NOT NULL
                              CHECK (agent_name IN (
                                'cole','atlas','carter','sage','pierce',
                                'hadley','quinn','sterling','ridge'
                              )),
  task_subject                TEXT NOT NULL CHECK (length(task_subject) <= 200),
  task_brief                  TEXT NOT NULL,
  priority                    INT NOT NULL DEFAULT 3
                              CHECK (priority BETWEEN 1 AND 5),
  depends_on                  UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  venture                     TEXT NOT NULL DEFAULT 'general'
                              CHECK (venture IN (
                                'dossie','paralegal','personal-agents',
                                'shepard-ventures','general'
                              )),
  status                      TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN (
                                'pending','in_progress','blocked',
                                'completed','cancelled'
                              )),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at                  TIMESTAMPTZ,
  completed_at                TIMESTAMPTZ,
  completed_by_agent_session  TEXT,
  result_summary              TEXT,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Indexes the picker needs to be fast:
--   pending lookup per agent, highest-priority first, oldest first as tiebreaker
CREATE INDEX IF NOT EXISTS idx_agent_queue_pending_pick
  ON agent_queue (agent_name, priority, created_at)
  WHERE status = 'pending';

--   in-flight lookup ("what's each agent currently on?")
CREATE INDEX IF NOT EXISTS idx_agent_queue_in_progress
  ON agent_queue (agent_name)
  WHERE status = 'in_progress';

--   dependency resolution: "is task X completed yet?" — random-access on id
CREATE INDEX IF NOT EXISTS idx_agent_queue_status_completed
  ON agent_queue (id)
  WHERE status = 'completed';

COMMENT ON TABLE agent_queue IS
  'Pending + in-flight work items per agent. Source of truth for the orchestrator. Cole/Jarvis populates, picker assigns, agents execute.';
COMMENT ON COLUMN agent_queue.depends_on IS
  'Array of agent_queue.id values that must be status=completed before this task is eligible to pick.';
COMMENT ON COLUMN agent_queue.priority IS
  '1=critical, 2=high, 3=normal, 4=low, 5=background. Lower number = picked first.';
COMMENT ON COLUMN agent_queue.completed_by_agent_session IS
  'Free-form identifier of the agent session that completed it (e.g. claude-code session id, or "cron-process-agent-requests:RUN_ID").';

-- ─── agent_state ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_state (
  agent_name        TEXT PRIMARY KEY
                    CHECK (agent_name IN (
                      'cole','atlas','carter','sage','pierce',
                      'hadley','quinn','sterling','ridge'
                    )),
  status            TEXT NOT NULL DEFAULT 'idle'
                    CHECK (status IN (
                      'working','idle','sleeping','unavailable'
                    )),
  current_task_id   UUID REFERENCES agent_queue(id) ON DELETE SET NULL,
  last_active_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE agent_state IS
  'One row per known agent — current assignment + heartbeat. Picker reads this to decide who is free. Agents update last_heartbeat_at while running.';
COMMENT ON COLUMN agent_state.status IS
  'working = on a task; idle = ready for one; sleeping = quiet hours (Cole respects this); unavailable = manually offlined (rare).';

-- Seed one row per agent so the picker has somebody to look at on first run.
INSERT INTO agent_state (agent_name, status) VALUES
  ('cole',     'idle'),
  ('atlas',    'idle'),
  ('carter',   'idle'),
  ('sage',     'idle'),
  ('pierce',   'idle'),
  ('hadley',   'idle'),
  ('quinn',    'idle'),
  ('sterling', 'idle'),
  ('ridge',    'idle')
ON CONFLICT (agent_name) DO NOTHING;

-- ─── RLS lockdown ────────────────────────────────────────────────────────────
-- Service-role only. Same posture as agent_messages / cron_runs. No user-facing
-- direct reads — every consumer goes through an authed API endpoint that
-- verifies Heath's JWT (see /api/queue-task, /api/agent-queue-claim, etc.).

ALTER TABLE agent_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_state ENABLE ROW LEVEL SECURITY;
-- (no policies → all access requires service_role)

-- ─── Helper view: ready-to-pick tasks ────────────────────────────────────────
-- Encapsulates the dependency-satisfaction check so picker code stays clean.
-- A task is "ready" if status='pending' AND every UUID in depends_on either
-- (a) doesn't exist in agent_queue at all (stale/cancelled dependency cleanup
-- shouldn't block forever) OR (b) has status='completed'.

CREATE OR REPLACE VIEW agent_queue_ready AS
SELECT q.*
FROM agent_queue q
WHERE q.status = 'pending'
  AND (
    cardinality(q.depends_on) = 0
    OR NOT EXISTS (
      SELECT 1
      FROM unnest(q.depends_on) AS dep_id
      LEFT JOIN agent_queue dep ON dep.id = dep_id
      WHERE dep.id IS NOT NULL
        AND dep.status <> 'completed'
    )
  );

COMMENT ON VIEW agent_queue_ready IS
  'Pending tasks whose dependencies are satisfied. Picker queries: SELECT * FROM agent_queue_ready WHERE agent_name=$1 ORDER BY priority, created_at LIMIT 1.';
