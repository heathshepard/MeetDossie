-- ============================================================================
-- Widen agent_queue / agent_state agent_name CHECK constraints to the full
-- 12-agent roster.
--
-- WHY: 20260617_agent_queue.sql hardcoded the CHECK to the 9 agents that
-- existed at the time (cole/atlas/carter/sage/pierce/hadley/quinn/sterling/
-- ridge). Four more agents have since been added to .claude/agents/*.md
-- (brokerage, sawyer, warden, content-verifier) with full app-layer support
-- added 2026-08-09 (SV-ENG-AGENT-QUEUE-NO-FAKE-RACE) —
-- scripts/agent-queue-poller.js's SPAWNABLE_AGENTS, api/agent-queue-claim.js
-- + api/cole-enqueue.js's VALID_AGENTS, and _jarvis_tools.js's spawn_agent
-- tool enum. None of that matters until this DB-level constraint is widened
-- to match — every INSERT for those 4 agents currently fails with
-- "violates check constraint agent_queue_agent_name_check" /
-- "agent_state_agent_name_check" (confirmed live 2026-08-09 attempting to
-- seed agent_state rows for them).
--
-- Safe / additive only: widens two CHECK constraints, no data touched, no
-- column changes, no drops.
--
-- Owner: Atlas, 2026-08-09 (SV-ENG-AGENT-QUEUE-NO-FAKE-RACE)
-- ============================================================================

ALTER TABLE agent_queue DROP CONSTRAINT IF EXISTS agent_queue_agent_name_check;
ALTER TABLE agent_queue ADD CONSTRAINT agent_queue_agent_name_check
  CHECK (agent_name IN (
    'cole','atlas','carter','sage','pierce',
    'hadley','quinn','sterling','ridge',
    'brokerage','sawyer','warden','content-verifier'
  ));

ALTER TABLE agent_state DROP CONSTRAINT IF EXISTS agent_state_agent_name_check;
ALTER TABLE agent_state ADD CONSTRAINT agent_state_agent_name_check
  CHECK (agent_name IN (
    'cole','atlas','carter','sage','pierce',
    'hadley','quinn','sterling','ridge',
    'brokerage','sawyer','warden','content-verifier'
  ));

-- Seed agent_state rows for the 4 new agents so the picker/HUD has somebody
-- to look at, matching the seed pattern in 20260617_agent_queue.sql.
INSERT INTO agent_state (agent_name, status) VALUES
  ('brokerage',        'idle'),
  ('sawyer',            'idle'),
  ('warden',            'idle'),
  ('content-verifier',  'idle')
ON CONFLICT (agent_name) DO NOTHING;
