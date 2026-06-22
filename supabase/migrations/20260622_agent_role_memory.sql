-- ============================================================================
-- Jarvis PWA — Shared Agent Memory Pool (locked 2026-06-22)
-- ============================================================================
-- Built by atlas_2 on top of atlas_1's instance + checklist + projects infra.
--
-- Heath spec verbatim:
-- "I want each agent instance to share memory and learning. I don't want
--  atlas_2 to finish a job and that experience and learning is gone forever.
--  How do we make our atlas agents (and every other agent, especially jarvis)
--  always learning and improving?"
--
-- Design: one shared role-scoped knowledge pool. Every spawned instance
-- (atlas_1, atlas_2, atlas_3, ...) reads from the same agent_role='atlas'
-- pool. When an instance learns something tricky, it POSTs to
-- /api/agent-memory-learn, the system embeds + dedupes (cosine > 0.92 ->
-- increment usage_count instead of insert), and the next spawn loads top-N
-- relevant lessons into its system prompt.
--
-- Tables:
--   agent_role_memory      — the shared learning pool, embedded for semantic search
-- Schema highlights:
--   * pgvector(1536) for OpenAI text-embedding-3-small compatibility
--   * ivfflat index for fast nearest-neighbor search
--   * usage_count tracks how many spawns have benefited from this lesson
--   * validation_status: auto -> heath_approved | contested | archived
--   * tags jsonb for filtering (project, tool, language, ...)
--   * learned_by_instance_id nullable for seeded entries
-- ============================================================================

-- Enable pgvector
create extension if not exists vector;

-- ----------------------------------------------------------------------------
-- 1. agent_role_memory — shared role-scoped knowledge pool
-- ----------------------------------------------------------------------------
create table if not exists public.agent_role_memory (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants(id) on delete cascade,
  agent_role               text not null check (agent_role in
                             ('atlas','carter','hadley','pierce','sage','ridge','quinn','sterling','jarvis')),
  title                    text not null check (length(title) between 1 and 200),
  content                  text not null check (length(content) between 1 and 4000),
  category                 text not null default 'workflow' check (category in (
                             'api_gotcha',
                             'workflow',
                             'code_pattern',
                             'external_service_quirk',
                             'heath_preference',
                             'customer_pattern',
                             'legal_nuance',
                             'security',
                             'cost_optimization',
                             'voice_ux'
                           )),
  learned_by_instance_id   uuid references public.jarvis_agent_instances(id) on delete set null,
  learned_at               timestamptz not null default now(),
  validation_status        text not null default 'auto' check (validation_status in (
                             'auto','heath_approved','contested','archived'
                           )),
  usage_count              int not null default 0,
  source_instance_ids      jsonb not null default '[]'::jsonb,  -- track all instances that arrived at this lesson via dedupe
  embedding                vector(1536),                          -- nullable: API back-fills async if embed fails
  tags                     jsonb not null default '[]'::jsonb,    -- array of short strings
  last_used_at             timestamptz,                           -- updated when this lesson is loaded into a spawn
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists idx_arm_tenant_role
  on public.agent_role_memory(tenant_id, agent_role, validation_status);
create index if not exists idx_arm_tenant_recent
  on public.agent_role_memory(tenant_id, learned_at desc);
create index if not exists idx_arm_usage
  on public.agent_role_memory(tenant_id, agent_role, usage_count desc);

-- Approximate nearest neighbor index for semantic search.
-- ivfflat with 100 lists is plenty for our (low) row counts; rebuild later if we exceed ~50k rows.
create index if not exists idx_arm_embedding_cosine
  on public.agent_role_memory
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

comment on table public.agent_role_memory is
  'Shared role-scoped knowledge pool. Every instance of agent_role X reads this pool when spawned and contributes new lessons it learns. Locked 2026-06-22.';

-- updated_at trigger (re-uses jarvis_touch_updated_at from prior migration)
do $$
begin
  if exists (select 1 from pg_proc where proname = 'jarvis_touch_updated_at') then
    execute 'drop trigger if exists trg_arm_updated_at on public.agent_role_memory';
    execute 'create trigger trg_arm_updated_at
             before update on public.agent_role_memory
             for each row execute function public.jarvis_touch_updated_at()';
  end if;
end$$;

-- ----------------------------------------------------------------------------
-- 2. Row Level Security — tenant isolation via jarvis_current_tenant_id()
-- ----------------------------------------------------------------------------
alter table public.agent_role_memory enable row level security;

drop policy if exists arm_tenant_all on public.agent_role_memory;
create policy arm_tenant_all on public.agent_role_memory
  for all
  using (tenant_id = public.jarvis_current_tenant_id())
  with check (tenant_id = public.jarvis_current_tenant_id());

-- ----------------------------------------------------------------------------
-- 3. Realtime publication membership
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'agent_role_memory'
  ) then
    execute 'alter publication supabase_realtime add table public.agent_role_memory';
  end if;
end$$;

-- ----------------------------------------------------------------------------
-- 4. Semantic-search RPC — returns top N lessons ranked by similarity * boost
-- ----------------------------------------------------------------------------
-- Score formula:
--   final = cosine_similarity * (1 + log(1 + usage_count) * 0.15) * recency_boost
--   recency_boost = 1.0 if validated, 0.85 if contested
--                 + small bump for last 14 days
-- Returns rows whose cosine similarity is at least match_threshold (default 0.5).
-- Heath-approved entries get a +0.10 final-score bonus to surface canonical truth.
create or replace function public.agent_memory_search(
  p_tenant_id     uuid,
  p_agent_role    text,
  p_query_embed   vector(1536),
  p_match_threshold double precision default 0.5,
  p_match_count   int default 20
)
returns table (
  id              uuid,
  title           text,
  content         text,
  category        text,
  tags            jsonb,
  usage_count     int,
  validation_status text,
  learned_at      timestamptz,
  similarity      double precision,
  score           double precision
)
language sql
stable
as $$
  select
    m.id,
    m.title,
    m.content,
    m.category,
    m.tags,
    m.usage_count,
    m.validation_status,
    m.learned_at,
    (1 - (m.embedding <=> p_query_embed))::double precision as similarity,
    (
      (1 - (m.embedding <=> p_query_embed))
      * (1 + ln(1 + m.usage_count) * 0.15)
      * case when extract(epoch from (now() - m.learned_at))/86400 < 14 then 1.10 else 1.0 end
      * case m.validation_status
          when 'heath_approved' then 1.20
          when 'auto'           then 1.00
          when 'contested'      then 0.70
          when 'archived'       then 0.00
        end
    )::double precision as score
  from public.agent_role_memory m
  where m.tenant_id    = p_tenant_id
    and m.agent_role   = p_agent_role
    and m.validation_status <> 'archived'
    and m.embedding is not null
    and (1 - (m.embedding <=> p_query_embed)) >= p_match_threshold
  order by score desc
  limit greatest(p_match_count, 1);
$$;

comment on function public.agent_memory_search is
  'Semantic search over agent_role_memory. Used by /api/agent-memory-load to seed spawn prompts with prior learnings. Locked 2026-06-22.';

-- ----------------------------------------------------------------------------
-- 5. Dedupe RPC — find existing lesson with cosine similarity > threshold
-- ----------------------------------------------------------------------------
create or replace function public.agent_memory_find_duplicate(
  p_tenant_id     uuid,
  p_agent_role    text,
  p_query_embed   vector(1536),
  p_threshold     double precision default 0.92
)
returns table (
  id          uuid,
  similarity  double precision,
  usage_count int
)
language sql
stable
as $$
  select
    m.id,
    (1 - (m.embedding <=> p_query_embed))::double precision as similarity,
    m.usage_count
  from public.agent_role_memory m
  where m.tenant_id = p_tenant_id
    and m.agent_role = p_agent_role
    and m.validation_status <> 'archived'
    and m.embedding is not null
    and (1 - (m.embedding <=> p_query_embed)) >= p_threshold
  order by m.embedding <=> p_query_embed
  limit 1;
$$;

comment on function public.agent_memory_find_duplicate is
  'Pre-insert dedupe lookup. If similarity > 0.92 the caller should increment usage_count + append instance to source_instance_ids instead of inserting a new row. Locked 2026-06-22.';
