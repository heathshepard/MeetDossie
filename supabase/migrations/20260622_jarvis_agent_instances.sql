-- ============================================================================
-- Jarvis PWA — Agent Instance Cloning SOP (locked 2026-06-22)
-- ============================================================================
-- Locked by Heath verbatim:
-- "I also think it would be a good idea to only have 1 agent working on one
--  project at a time so if another agent needs to be spawned. Let's clone the
--  appropriate agent to build simultaneously..."
--
-- Schema:
--   jarvis_projects             — units of work (TREC v2 KB, Founder reactivation, etc.)
--   jarvis_agent_instances      — per-spawn instance (atlas_1, atlas_2, hadley_1, ...)
--   jarvis_agent_checklist      — checklist items the instance must complete
--
-- All multi-tenant via tenant_id, RLS isolated via jarvis_current_tenant_id().
-- All added to supabase_realtime publication for live UI updates.
-- Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. jarvis_projects — top-level units of work
-- ----------------------------------------------------------------------------
create table if not exists public.jarvis_projects (
  id                         uuid primary key default gen_random_uuid(),
  tenant_id                  uuid not null references public.tenants(id) on delete cascade,
  title                      text not null,
  description                text,
  status                     text not null default 'building'
                             check (status in ('planning','building','shipped','shelved','cancelled')),
  spawned_at                 timestamptz not null default now(),
  completed_at               timestamptz,
  owning_agent_instance_id   uuid,                -- FK added after instances table exists
  evidence_summary           text,
  gold_tag                   text,
  metadata                   jsonb,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

create index if not exists idx_jarvis_projects_tenant_status
  on public.jarvis_projects(tenant_id, status, spawned_at desc);
create index if not exists idx_jarvis_projects_tenant_completed
  on public.jarvis_projects(tenant_id, completed_at desc nulls last);

comment on table public.jarvis_projects is
  'Units of work tracked in the PROJECTS LEDGER panel. One project may be worked on by multiple agent instances over time. Locked 2026-06-22.';

-- ----------------------------------------------------------------------------
-- 2. jarvis_agent_instances — per-spawn instances (atlas_1, atlas_2, ...)
-- ----------------------------------------------------------------------------
create table if not exists public.jarvis_agent_instances (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  agent_role      text not null check (agent_role in
                    ('atlas','carter','hadley','pierce','sage','ridge','quinn','sterling','jarvis')),
  instance_number int not null,
  instance_id     text not null,            -- denormalized "atlas_3"; generated via trigger
  project_id      uuid references public.jarvis_projects(id) on delete set null,
  spawned_at      timestamptz not null default now(),
  completed_at    timestamptz,
  status          text not null default 'running'
                  check (status in ('running','completed','failed','cancelled')),
  spawn_prompt    text,
  metadata        jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, agent_role, instance_number)
);

create index if not exists idx_jarvis_inst_tenant_status
  on public.jarvis_agent_instances(tenant_id, status, spawned_at desc);
create index if not exists idx_jarvis_inst_project
  on public.jarvis_agent_instances(project_id);
create index if not exists idx_jarvis_inst_instance_id
  on public.jarvis_agent_instances(tenant_id, instance_id);

comment on table public.jarvis_agent_instances is
  'Per-spawn agent instance. instance_id like atlas_3 = atlas role, 3rd instance in this tenant. Locked 2026-06-22 SOP: one project per instance, clone to parallelize.';

-- Add FK from projects.owning_agent_instance_id now that instances table exists.
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'jarvis_projects_owning_agent_instance_id_fkey'
      and table_name = 'jarvis_projects'
  ) then
    alter table public.jarvis_projects
      add constraint jarvis_projects_owning_agent_instance_id_fkey
      foreign key (owning_agent_instance_id)
      references public.jarvis_agent_instances(id)
      on delete set null;
  end if;
end$$;

-- ----------------------------------------------------------------------------
-- 3. Auto-increment instance_number + denormalize instance_id via trigger
-- ----------------------------------------------------------------------------
create or replace function public.jarvis_assign_instance_number()
returns trigger
language plpgsql
as $$
declare
  next_num int;
begin
  if NEW.instance_number is null or NEW.instance_number = 0 then
    select coalesce(max(instance_number), 0) + 1
      into next_num
      from public.jarvis_agent_instances
      where tenant_id = NEW.tenant_id and agent_role = NEW.agent_role;
    NEW.instance_number := next_num;
  end if;
  NEW.instance_id := NEW.agent_role || '_' || NEW.instance_number::text;
  return NEW;
end;
$$;

drop trigger if exists trg_jarvis_assign_instance_number on public.jarvis_agent_instances;
create trigger trg_jarvis_assign_instance_number
  before insert on public.jarvis_agent_instances
  for each row execute function public.jarvis_assign_instance_number();

-- updated_at maintenance
create or replace function public.jarvis_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  NEW.updated_at := now();
  return NEW;
end;
$$;

drop trigger if exists trg_jarvis_projects_updated_at on public.jarvis_projects;
create trigger trg_jarvis_projects_updated_at
  before update on public.jarvis_projects
  for each row execute function public.jarvis_touch_updated_at();

drop trigger if exists trg_jarvis_instances_updated_at on public.jarvis_agent_instances;
create trigger trg_jarvis_instances_updated_at
  before update on public.jarvis_agent_instances
  for each row execute function public.jarvis_touch_updated_at();

-- ----------------------------------------------------------------------------
-- 4. jarvis_agent_checklist — per-instance checklist items
-- ----------------------------------------------------------------------------
create table if not exists public.jarvis_agent_checklist (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  instance_id        uuid not null references public.jarvis_agent_instances(id) on delete cascade,
  display_order      int not null default 0,
  title              text not null,
  status             text not null default 'pending'
                     check (status in ('pending','in_progress','completed','failed')),
  evidence_files     jsonb,
  commit_sha         text,
  screenshot_paths   jsonb,
  apv_status         text default 'not_run' check (apv_status in ('not_run','pass','fail')),
  started_at         timestamptz,
  completed_at       timestamptz,
  failure_reason     text,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_jarvis_checklist_instance
  on public.jarvis_agent_checklist(instance_id, display_order);
create index if not exists idx_jarvis_checklist_tenant
  on public.jarvis_agent_checklist(tenant_id, status);

drop trigger if exists trg_jarvis_checklist_updated_at on public.jarvis_agent_checklist;
create trigger trg_jarvis_checklist_updated_at
  before update on public.jarvis_agent_checklist
  for each row execute function public.jarvis_touch_updated_at();

comment on table public.jarvis_agent_checklist is
  'Checklist items an agent instance must complete. Updated in real-time via /api/jarvis-update-checklist-item. Drives the per-card progress + modal in the AGENT STATUS panel. Locked 2026-06-22.';

-- ----------------------------------------------------------------------------
-- 5. Row Level Security — tenant isolation via jarvis_current_tenant_id()
-- ----------------------------------------------------------------------------
alter table public.jarvis_projects         enable row level security;
alter table public.jarvis_agent_instances  enable row level security;
alter table public.jarvis_agent_checklist  enable row level security;

drop policy if exists jproj_tenant_all on public.jarvis_projects;
create policy jproj_tenant_all on public.jarvis_projects
  for all
  using (tenant_id = public.jarvis_current_tenant_id())
  with check (tenant_id = public.jarvis_current_tenant_id());

drop policy if exists jinst_tenant_all on public.jarvis_agent_instances;
create policy jinst_tenant_all on public.jarvis_agent_instances
  for all
  using (tenant_id = public.jarvis_current_tenant_id())
  with check (tenant_id = public.jarvis_current_tenant_id());

drop policy if exists jchk_tenant_all on public.jarvis_agent_checklist;
create policy jchk_tenant_all on public.jarvis_agent_checklist
  for all
  using (tenant_id = public.jarvis_current_tenant_id())
  with check (tenant_id = public.jarvis_current_tenant_id());

-- ----------------------------------------------------------------------------
-- 6. Realtime publication membership (live UI updates)
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'jarvis_projects',
    'jarvis_agent_instances',
    'jarvis_agent_checklist'
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
