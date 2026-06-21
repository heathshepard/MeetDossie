-- =============================================================================
-- Jarvis PWA Tier 2 — agent ledger column additions + voice brief cache
-- =============================================================================
-- Applied to production Supabase project pgwoitbdiyubjugwufhk 2026-06-20 via MCP.
-- Spec: 2026-06-21-jarvis-pwa-DOD-ADDENDUM-agent-ledger.md
--
-- Adds columns the Tier 2 agent ledger UI needs:
--   - task_title (short summary line, ~100 chars)
--   - prompt (full prompt given to the agent)
--   - status (spawned|working|completed|failed) — separate from event_type
--   - started_at, completed_at (lifecycle timestamps)
--   - result_summary (final outcome blob)
--   - commit_sha (link back to git)
--   - files_touched (jsonb array)
--   - screenshot_paths (jsonb array)
--   - apv_status (not_run|pass|fail)
--   - token_cost_cents (cost tracking)
--
-- All columns nullable for backward-compat with existing rows + the
-- _jarvis_tools.js spawn_agent helper (which only writes the original fields).
-- =============================================================================

alter table public.jarvis_agent_events
  add column if not exists task_title       text,
  add column if not exists prompt           text,
  add column if not exists status           text,
  add column if not exists started_at       timestamptz,
  add column if not exists completed_at     timestamptz,
  add column if not exists result_summary   text,
  add column if not exists commit_sha       text,
  add column if not exists files_touched    jsonb,
  add column if not exists screenshot_paths jsonb,
  add column if not exists apv_status       text,
  add column if not exists token_cost_cents integer;

alter table public.jarvis_agent_events
  drop constraint if exists jarvis_agent_events_status_check;
alter table public.jarvis_agent_events
  add constraint jarvis_agent_events_status_check
    check (status is null or status in ('spawned','working','completed','failed'));

alter table public.jarvis_agent_events
  drop constraint if exists jarvis_agent_events_apv_check;
alter table public.jarvis_agent_events
  add constraint jarvis_agent_events_apv_check
    check (apv_status is null or apv_status in ('not_run','pass','fail'));

create index if not exists idx_jarvis_agent_events_tenant_agent_started
  on public.jarvis_agent_events(tenant_id, agent_name, started_at desc nulls last);

-- =============================================================================
-- JARVIS_VOICE_BRIEFS — 12h cache of the morning brief audio.
-- =============================================================================
create table if not exists public.jarvis_voice_briefs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  brief_date    date not null,
  script_text   text not null,
  audio_mime    text not null default 'audio/mpeg',
  audio_bytes   bytea,
  duration_sec  integer,
  voice_id      text default 'JBFqnCBsd6RMkjVDRZzb',
  generated_at  timestamptz not null default now(),
  expires_at    timestamptz not null default (now() + interval '12 hours'),
  metadata      jsonb
);

create index if not exists idx_jarvis_voice_briefs_lookup
  on public.jarvis_voice_briefs(tenant_id, brief_date, expires_at desc);

alter table public.jarvis_voice_briefs enable row level security;

drop policy if exists voice_briefs_tenant_all on public.jarvis_voice_briefs;
create policy voice_briefs_tenant_all on public.jarvis_voice_briefs
  for all
  using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  with check (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
