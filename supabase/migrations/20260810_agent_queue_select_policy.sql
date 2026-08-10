-- ============================================================================
-- agent_queue: SELECT policy for Heath's authenticated session.
--
-- WHY: agent_queue has RLS ENABLED with ZERO policies (20260617_agent_queue.sql
-- — "no policies -> all access requires service_role"). That's correct for
-- writes (every insert path already goes through a service-role-backed API
-- route), but it silently breaks the Jarvis dashboard's Realtime subscription
-- to this table (jarvis-pwa.html's `agent_queue_stream` channel,
-- subscribeAgentEvents()): Supabase Realtime enforces the SAME RLS as REST
-- for the connecting role, so with zero SELECT policies the browser's
-- `authenticated` session receives ZERO postgres_changes events — confirmed
-- live 2026-08-10 while building the BUSINESS LINES panel (SV-ENG-
-- JARVIS-TASK-VIZ): a direct REST probe as Heath's own signed-in session
-- returned `200 []` against a table known to have rows. This means the
-- existing ACTIVITY LOG / AGENT STATUS ledger realtime feed has likely been
-- silently degraded to "30s poll only" this whole time too, not just the
-- new panel.
--
-- FIX: one narrow SELECT policy, scoped to Heath's email specifically (same
-- ALLOWED_EMAIL check api/queue-task.js already uses for the write side) —
-- NOT a blanket `TO authenticated USING (true)`. This Supabase project is
-- shared with the customer-facing Dossie app; a blanket policy would let any
-- paying customer's authenticated session read agent_queue (internal task
-- briefs, strategy notes, etc.) via REST or Realtime. This policy grants
-- read-only access to exactly one identity.
--
-- No change to INSERT/UPDATE/DELETE — those stay service-role-only via the
-- existing API routes.
--
-- Owner: Atlas, 2026-08-10 (SV-ENG-JARVIS-TASK-VIZ)
-- ============================================================================

DROP POLICY IF EXISTS agent_queue_heath_read ON agent_queue;
CREATE POLICY agent_queue_heath_read ON agent_queue
  FOR SELECT
  TO authenticated
  USING (auth.jwt() ->> 'email' = 'heath.shepard@kw.com');
