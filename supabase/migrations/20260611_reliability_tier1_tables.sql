-- SV-ENG-RELIABILITY Tier 1 — supporting tables (Atlas, 2026-06-11)
--
-- Three tables back the new reliability stack:
--   1. wall_log_entries          — institutional memory of every failure + route-around
--   2. platform_health_state     — current per-platform pause status (one row per platform)
--   3. platform_health_checks    — append-only probe history (1 row per probe per platform)
--
-- All three use service_role for writes (crons only). Reads gated to authenticated
-- users via the existing /api/ventures/* route handlers.

-- ─── wall_log_entries ────────────────────────────────────────────────────────
create table if not exists public.wall_log_entries (
  id uuid primary key default gen_random_uuid(),
  detected_at timestamptz not null default now(),
  wall_id text not null,
  title text not null,
  what_broke text,
  detected_by text,
  root_cause text,
  route_around text,
  permanent_fix text,
  resolved_by text,
  reoccurrence_guard text,
  metadata jsonb
);

create index if not exists idx_wall_log_entries_detected_at
  on public.wall_log_entries (detected_at desc);
create index if not exists idx_wall_log_entries_wall_id
  on public.wall_log_entries (wall_id);

alter table public.wall_log_entries enable row level security;

drop policy if exists "service role full access" on public.wall_log_entries;
create policy "service role full access"
  on public.wall_log_entries for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ─── platform_health_state ───────────────────────────────────────────────────
-- One row per platform. Upserted on every probe. Updated by:
--   cron-platform-health-checker (every 2h)
--   cron-account-session-monitor (every 6h)
create table if not exists public.platform_health_state (
  platform text primary key,
  consecutive_fails integer not null default 0,
  platform_pause_until timestamptz,
  last_probe_ok boolean,
  last_latency_ms integer,
  last_checked_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.platform_health_state enable row level security;

drop policy if exists "service role full access" on public.platform_health_state;
create policy "service role full access"
  on public.platform_health_state for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ─── platform_health_checks ─────────────────────────────────────────────────
-- Append-only probe history. cron-platform-health-checker inserts one row per
-- platform per probe cycle. Kept short (60-day retention recommended via
-- pg_cron or manual purge — not enforced by schema).
create table if not exists public.platform_health_checks (
  id uuid primary key default gen_random_uuid(),
  platform text not null,
  checked_at timestamptz not null default now(),
  ok boolean not null,
  latency_ms integer,
  http_status integer,
  error text,
  account_active boolean
);

create index if not exists idx_platform_health_checks_platform_time
  on public.platform_health_checks (platform, checked_at desc);

alter table public.platform_health_checks enable row level security;

drop policy if exists "service role full access" on public.platform_health_checks;
create policy "service role full access"
  on public.platform_health_checks for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ─── cron_runs unique constraint (idempotent) ───────────────────────────────
-- The wall-log writer in api/_lib/wall-log.js upserts cron_runs via on_conflict
-- on cron_name. If the table exists without a unique constraint, force one.
-- Wrapped in DO block to be safe across previous migration states.
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema='public' and table_name='cron_runs') then
    if not exists (
      select 1 from pg_indexes
       where schemaname='public' and tablename='cron_runs'
         and indexname='cron_runs_cron_name_key'
    ) then
      execute 'alter table public.cron_runs add constraint cron_runs_cron_name_key unique (cron_name)';
    end if;
  end if;
end$$;
