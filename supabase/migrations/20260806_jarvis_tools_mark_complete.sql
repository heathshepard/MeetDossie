-- 20260806_jarvis_tools_mark_complete.sql
-- ============================================================================
-- Enables the `mark_complete` tool (api/_jarvis_tools.js) for Heath's tenant.
-- Jarvis mission-control consolidation, item 6: closes the "auto-update as
-- we talk through it" gap by letting Heath say "that's done" in chat/voice
-- and resolving it against heath_todo / agent_queue / merge_queue.
--
-- Mirrors the seed pattern in 20260621_jarvis_pwa_init.sql. Idempotent —
-- safe to re-run.
--
-- NOTE: this migration must be applied (supabase db push, or the existing
-- one-time admin-migration pattern) before Jarvis can actually CALL the tool
-- in conversation. The standalone HTTP endpoint /api/jarvis-mark-complete
-- works immediately regardless — this migration only gates the tool-calling
-- path inside jarvis-voice.js / jarvis-claude-code.js.
--
-- Owner: Atlas — 2026-08-06
-- ============================================================================

insert into public.jarvis_tools (tenant_id, tool_name, enabled)
select t.id, 'mark_complete', true from public.tenants t
where t.slug = 'heath'
on conflict (tenant_id, tool_name) do update set enabled = true;
