-- ============================================================================
-- Jarvis PWA — add jarvis_* tables to the supabase_realtime publication.
-- Drafted by Atlas 2026-06-21 to fix Session 1 Quinn QA P0:
-- the agent-status panel subscribed via supabase.channel(...) but never
-- received broadcasts because jarvis_agent_events was not a member of the
-- supabase_realtime publication.
--
-- Idempotent: re-runnable. Skips tables already in the publication.
--
-- DoD reference: criterion 46 (agent panel updates via Supabase Realtime).
-- ============================================================================
do $$
declare
  t text;
  tables text[] := array[
    'jarvis_agent_events',
    'jarvis_conversations',
    'jarvis_messages',
    'jarvis_tool_invocations'
  ];
begin
  foreach t in array tables loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end$$;
