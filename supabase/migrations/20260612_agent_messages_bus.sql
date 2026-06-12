-- ============================================================================
-- agent_messages — Shared bus / shared-context layer for the Shepard Ventures
-- agent team (Cole, Sage, Carter, Atlas, Pierce, Sterling, Hadley, Ridge, +
-- Heath).
--
-- Purpose: Phase A of cross-agent observability. Every input the user/agent
-- sees, every dispatch one agent sends to another, every output an agent
-- produces, every status update, every observation — written here. Other
-- agents can read recent context BEFORE acting, so they're not flying blind
-- about what the team has been doing.
--
-- Phase A scope (this migration):
--   - The table
--   - Two indexes (per-agent recent + per-target dispatch inbox)
--   - RLS DISABLED — only the service_role key writes/reads (server-side
--     helper lib in api/_lib/agent-bus.js). No user-facing endpoint.
--
-- Phase B (deferred): persistent agent sessions that long-poll this table
-- to react to each other's traffic.
--
-- Owner: Atlas (SV-ENG-AGENT-BUS-PHASE-A / 2026-06-12)
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name      TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('input','output','status','dispatch','observation')),
  content         TEXT NOT NULL,
  in_reply_to     UUID REFERENCES agent_messages(id) ON DELETE SET NULL,
  routing_target  TEXT,
  metadata        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-agent timeline: "what has agent X said/heard recently?"
CREATE INDEX IF NOT EXISTS idx_agent_messages_agent_created
  ON agent_messages(agent_name, created_at DESC);

-- Per-target dispatch inbox: "what dispatches are waiting for agent Y?"
-- Filtered to role='dispatch' to keep the index small.
CREATE INDEX IF NOT EXISTS idx_agent_messages_target_unread
  ON agent_messages(routing_target, created_at)
  WHERE role = 'dispatch';

-- Lock down. Only service_role touches this table.
ALTER TABLE agent_messages ENABLE ROW LEVEL SECURITY;

-- No SELECT/INSERT policies created → all access requires service_role
-- (which bypasses RLS). This is intentional. If we ever need to expose
-- a slice to authenticated users, add a narrow policy then.

COMMENT ON TABLE agent_messages IS 'Shared cross-agent context bus. Phase A of agent observability layer. Service-role-only.';
COMMENT ON COLUMN agent_messages.agent_name IS 'cole | sage | carter | atlas | pierce | sterling | hadley | ridge | heath';
COMMENT ON COLUMN agent_messages.role IS 'input (received) | output (produced) | status (self-emitted heartbeat) | dispatch (to another agent) | observation (auto-captured signal)';
COMMENT ON COLUMN agent_messages.routing_target IS 'When role=dispatch, the target agent name. Null otherwise.';
COMMENT ON COLUMN agent_messages.in_reply_to IS 'Optional FK to the message that triggered this one. Lets us reconstruct threads.';
