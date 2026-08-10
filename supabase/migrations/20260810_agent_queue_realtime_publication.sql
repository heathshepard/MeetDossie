-- ============================================================================
-- agent_queue: add to the supabase_realtime publication.
--
-- WHY: the agent_queue_heath_read SELECT policy (20260810_agent_queue_select_
-- policy.sql) fixed RLS, but Realtime postgres_changes events are ALSO gated
-- on publication membership — a table has to be added to the
-- `supabase_realtime` publication before Postgres emits change events to it
-- at all, independent of RLS. Confirmed live 2026-08-10 while verifying the
-- BUSINESS LINES panel (SV-ENG-JARVIS-TASK-VIZ): `select tablename from
-- pg_publication_tables where pubname = 'supabase_realtime'` did not include
-- agent_queue, even after the SELECT policy was in place — the panel's
-- jarvis-pwa.html `agent_queue_stream` channel subscribes to
-- postgres_changes on agent_queue and was receiving zero events for that
-- reason, not just the RLS gap.
--
-- Default replica identity (primary key) is sufficient for INSERT/DELETE
-- payloads and for UPDATE payloads where the app only needs new-row data
-- (this is the case here — jarvis-pwa.html reads payload.new).
--
-- Owner: Atlas, 2026-08-10 (SV-ENG-JARVIS-TASK-VIZ)
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'agent_queue'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE agent_queue;
  END IF;
END $$;
