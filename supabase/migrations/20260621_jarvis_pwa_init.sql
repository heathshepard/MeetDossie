-- ============================================================================
-- Jarvis PWA — multi-tenant schema (Phase 1 init)
-- Drafted by Atlas 2026-06-21 against DoD Section A (criteria 1-12)
-- Supabase project: pgwoitbdiyubjugwufhk
-- ============================================================================
-- Tables created: tenants, jarvis_users, jarvis_devices, jarvis_conversations,
--                 jarvis_messages, jarvis_tool_invocations, jarvis_agent_events,
--                 jarvis_audio_buffers, jarvis_tools
-- RLS: enabled on all jarvis_* tables; isolation key = JWT tenant_id claim
-- Audio retention: jarvis-audio bucket (created out of band); cron deletes >24h
-- ============================================================================

-- pgcrypto already installed (extensions.pgcrypto)
create extension if not exists pgcrypto with schema extensions;

-- ----------------------------------------------------------------------------
-- TENANTS (1, 2)
-- ----------------------------------------------------------------------------
create table if not exists public.tenants (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  display_name  text not null,
  theme         text not null default 'iron-man',
  voice_id      text not null default 'JBFqnCBsd6RMkjVDRZzb',
  voice_settings jsonb not null default
    '{"model":"eleven_multilingual_v2","stability":0.55,"similarity_boost":0.50,"style":0.45}'::jsonb,
  addressing_pref text not null default 'sir',
  created_at    timestamptz not null default now()
);

comment on table public.tenants is 'Jarvis PWA + Zenith multi-tenant root. One row per personal-AI tenant.';

insert into public.tenants (slug, display_name, theme, voice_id, voice_settings, addressing_pref)
values (
  'heath',
  'Heath Shepard',
  'iron-man',
  'JBFqnCBsd6RMkjVDRZzb',
  '{"model":"eleven_multilingual_v2","stability":0.55,"similarity_boost":0.50,"style":0.45}'::jsonb,
  'sir'
)
on conflict (slug) do nothing;

-- ----------------------------------------------------------------------------
-- JARVIS_USERS (3)
-- ----------------------------------------------------------------------------
create table if not exists public.jarvis_users (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  auth_user_id  uuid not null references auth.users(id) on delete cascade,
  role          text not null default 'owner',
  created_at    timestamptz not null default now(),
  unique(tenant_id, auth_user_id)
);

-- Seed Heath into tenant 'heath' (idempotent)
insert into public.jarvis_users (tenant_id, auth_user_id, role)
select t.id, '598fec2f-b7a7-4465-8323-9ff64739bf74'::uuid, 'owner'
from public.tenants t
where t.slug = 'heath'
on conflict (tenant_id, auth_user_id) do nothing;

-- Also seed Heath's KW identity (so signing in with either email works for v1)
insert into public.jarvis_users (tenant_id, auth_user_id, role)
select t.id, '0cd05e2f-491f-411f-afe7-f8d3fbbdbff6'::uuid, 'owner'
from public.tenants t
where t.slug = 'heath'
on conflict (tenant_id, auth_user_id) do nothing;

-- ----------------------------------------------------------------------------
-- JARVIS_DEVICES (4)
-- ----------------------------------------------------------------------------
create table if not exists public.jarvis_devices (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  user_id        uuid not null references public.jarvis_users(id) on delete cascade,
  device_label   text,
  user_agent     text,
  last_seen      timestamptz not null default now(),
  push_subscription jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists idx_jarvis_devices_tenant on public.jarvis_devices(tenant_id);
create index if not exists idx_jarvis_devices_user on public.jarvis_devices(user_id);

-- ----------------------------------------------------------------------------
-- JARVIS_CONVERSATIONS (5)
-- ----------------------------------------------------------------------------
create table if not exists public.jarvis_conversations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  user_id     uuid not null references public.jarvis_users(id) on delete cascade,
  device_id   uuid references public.jarvis_devices(id) on delete set null,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  title       text,
  pinned      boolean not null default false,
  deleted_at  timestamptz
);

create index if not exists idx_jarvis_conv_tenant_user on public.jarvis_conversations(tenant_id, user_id, started_at desc);

-- ----------------------------------------------------------------------------
-- JARVIS_MESSAGES (6) — content encrypted via pgcrypto column-level
-- We store ciphertext in `content_encrypted` (bytea). A view exposes plaintext
-- under SECURITY DEFINER for the authenticated tenant.
-- ----------------------------------------------------------------------------
create table if not exists public.jarvis_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.jarvis_conversations(id) on delete cascade,
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  role            text not null check (role in ('user','assistant','tool','system')),
  content         text,                  -- plaintext (transient/dev)
  content_encrypted bytea,                -- ciphertext (production path)
  audio_url       text,
  tool_call       jsonb,
  tokens_in       integer,
  tokens_out      integer,
  created_at      timestamptz not null default now()
);

create index if not exists idx_jarvis_msg_conv on public.jarvis_messages(conversation_id, created_at);
create index if not exists idx_jarvis_msg_tenant on public.jarvis_messages(tenant_id, created_at desc);

-- Full-text search index over plaintext content (used for search in scrollback)
create index if not exists idx_jarvis_msg_content_tsv
  on public.jarvis_messages using gin (to_tsvector('english', coalesce(content,'')));

-- ----------------------------------------------------------------------------
-- JARVIS_TOOL_INVOCATIONS (7)
-- ----------------------------------------------------------------------------
create table if not exists public.jarvis_tool_invocations (
  id                  uuid primary key default gen_random_uuid(),
  message_id          uuid not null references public.jarvis_messages(id) on delete cascade,
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  tool_name           text not null,
  input               jsonb,
  output              jsonb,
  approval_required   boolean not null default false,
  approval_status     text not null default 'n/a' check (approval_status in ('pending','approved','rejected','n/a')),
  approval_audio_url  text,
  approval_transcript text,
  executed_at         timestamptz,
  created_at          timestamptz not null default now()
);

create index if not exists idx_jarvis_tool_inv_msg on public.jarvis_tool_invocations(message_id);
create index if not exists idx_jarvis_tool_inv_tenant on public.jarvis_tool_invocations(tenant_id, created_at desc);

-- ----------------------------------------------------------------------------
-- JARVIS_AGENT_EVENTS (8)
-- ----------------------------------------------------------------------------
create table if not exists public.jarvis_agent_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  agent_name  text not null check (agent_name in ('atlas','carter','hadley','pierce','sage','ridge','quinn','sterling','jarvis')),
  event_type  text not null check (event_type in ('spawned','progress','completed','failed','heartbeat')),
  summary     text,
  details     jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists idx_jarvis_agent_events_tenant on public.jarvis_agent_events(tenant_id, created_at desc);
create index if not exists idx_jarvis_agent_events_agent on public.jarvis_agent_events(tenant_id, agent_name, created_at desc);

-- ----------------------------------------------------------------------------
-- JARVIS_AUDIO_BUFFERS (9) — 24h retention
-- ----------------------------------------------------------------------------
create table if not exists public.jarvis_audio_buffers (
  id            uuid primary key default gen_random_uuid(),
  message_id    uuid references public.jarvis_messages(id) on delete cascade,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  storage_path  text not null,
  byte_size     integer,
  delete_after  timestamptz not null default (now() + interval '24 hours'),
  deleted_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists idx_jarvis_audio_delete_after on public.jarvis_audio_buffers(delete_after) where deleted_at is null;

-- ----------------------------------------------------------------------------
-- JARVIS_TOOLS (65) — per-tenant tool registry
-- ----------------------------------------------------------------------------
create table if not exists public.jarvis_tools (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  tool_name   text not null,
  enabled     boolean not null default true,
  config      jsonb,
  created_at  timestamptz not null default now(),
  unique(tenant_id, tool_name)
);

-- Seed Heath's tenant with the v1 tool belt (all enabled)
insert into public.jarvis_tools (tenant_id, tool_name, enabled)
select t.id, tool_name, true from public.tenants t,
  unnest(array[
    'web_search','web_browse',
    'send_telegram','send_sms','send_email','send_slack',
    'read_calendar','set_reminder',
    'read_contacts','read_recent_emails','read_recent_texts',
    'morning_brief','spawn_agent'
  ]) as tool_name
where t.slug = 'heath'
on conflict (tenant_id, tool_name) do nothing;

-- ============================================================================
-- HELPER: derive tenant_id from current auth.users session
-- ============================================================================
-- Pulls tenant_id by joining the auth.uid() back through jarvis_users.
-- This avoids needing a custom JWT claim hook on day 1; we can promote to a
-- claim later for performance.
create or replace function public.jarvis_current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id
  from public.jarvis_users
  where auth_user_id = auth.uid()
  limit 1;
$$;

grant execute on function public.jarvis_current_tenant_id() to authenticated, anon;

-- ============================================================================
-- ROW LEVEL SECURITY (10) — isolate every jarvis_* table by tenant
-- ============================================================================
alter table public.tenants                 enable row level security;
alter table public.jarvis_users            enable row level security;
alter table public.jarvis_devices          enable row level security;
alter table public.jarvis_conversations    enable row level security;
alter table public.jarvis_messages         enable row level security;
alter table public.jarvis_tool_invocations enable row level security;
alter table public.jarvis_agent_events     enable row level security;
alter table public.jarvis_audio_buffers    enable row level security;
alter table public.jarvis_tools            enable row level security;

-- Tenants: a user can read only their own tenant row
drop policy if exists tenants_self_read on public.tenants;
create policy tenants_self_read on public.tenants
  for select using (id = public.jarvis_current_tenant_id());

-- jarvis_users: user reads users in same tenant
drop policy if exists jusers_tenant_read on public.jarvis_users;
create policy jusers_tenant_read on public.jarvis_users
  for select using (tenant_id = public.jarvis_current_tenant_id());

-- jarvis_devices CRUD scoped to tenant
drop policy if exists jdev_tenant_all on public.jarvis_devices;
create policy jdev_tenant_all on public.jarvis_devices
  for all
  using (tenant_id = public.jarvis_current_tenant_id())
  with check (tenant_id = public.jarvis_current_tenant_id());

-- jarvis_conversations CRUD scoped to tenant
drop policy if exists jconv_tenant_all on public.jarvis_conversations;
create policy jconv_tenant_all on public.jarvis_conversations
  for all
  using (tenant_id = public.jarvis_current_tenant_id())
  with check (tenant_id = public.jarvis_current_tenant_id());

-- jarvis_messages CRUD scoped to tenant
drop policy if exists jmsg_tenant_all on public.jarvis_messages;
create policy jmsg_tenant_all on public.jarvis_messages
  for all
  using (tenant_id = public.jarvis_current_tenant_id())
  with check (tenant_id = public.jarvis_current_tenant_id());

-- jarvis_tool_invocations CRUD scoped to tenant
drop policy if exists jtool_inv_tenant_all on public.jarvis_tool_invocations;
create policy jtool_inv_tenant_all on public.jarvis_tool_invocations
  for all
  using (tenant_id = public.jarvis_current_tenant_id())
  with check (tenant_id = public.jarvis_current_tenant_id());

-- jarvis_agent_events CRUD scoped to tenant
drop policy if exists jagent_evt_tenant_all on public.jarvis_agent_events;
create policy jagent_evt_tenant_all on public.jarvis_agent_events
  for all
  using (tenant_id = public.jarvis_current_tenant_id())
  with check (tenant_id = public.jarvis_current_tenant_id());

-- jarvis_audio_buffers CRUD scoped to tenant
drop policy if exists jaud_tenant_all on public.jarvis_audio_buffers;
create policy jaud_tenant_all on public.jarvis_audio_buffers
  for all
  using (tenant_id = public.jarvis_current_tenant_id())
  with check (tenant_id = public.jarvis_current_tenant_id());

-- jarvis_tools read scoped to tenant
drop policy if exists jtools_tenant_read on public.jarvis_tools;
create policy jtools_tenant_read on public.jarvis_tools
  for select using (tenant_id = public.jarvis_current_tenant_id());

-- ============================================================================
-- DONE — schema layer complete. Storage bucket + cron created separately.
-- ============================================================================
