-- SV-ENG-QA-HOURLY — qa_loop_runs table (Atlas, 2026-06-11)
--
-- Backs the hourly Dossie QA loop. Tracks each iteration's cost, fix-ship count,
-- scenario rotation, demo-collision deferrals, and severity-aware outcomes so
-- guardrails (cost cap, fix-ship cap) can self-enforce without external state.
--
-- Reads gated to service_role only (Cole + Carter access via API route, never UI).

create table if not exists public.qa_loop_runs (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz not null default now(),
  scenario_day integer not null,
  scenario_title text not null,
  iteration_status text not null default 'completed',
    -- 'completed' | 'deferred_demo_collision' | 'skipped_cost_cap' | 'skipped_ship_cap' | 'errored'
  passed boolean not null default false,
  failure_count integer not null default 0,
  p0_count integer not null default 0,
  p1_count integer not null default 0,
  p2_count integer not null default 0,
  fix_shipped boolean not null default false,
  fix_severity text,
  fix_summary text,
  claude_cost_usd numeric(10, 6) not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  findings jsonb,
  notes text
);

create index if not exists idx_qa_loop_runs_ran_at
  on public.qa_loop_runs (ran_at desc);
create index if not exists idx_qa_loop_runs_ran_at_day
  on public.qa_loop_runs (date_trunc('day', ran_at at time zone 'UTC'));
create index if not exists idx_qa_loop_runs_fix_shipped
  on public.qa_loop_runs (fix_shipped, ran_at desc) where fix_shipped = true;

alter table public.qa_loop_runs enable row level security;

drop policy if exists "service role full access" on public.qa_loop_runs;
create policy "service role full access"
  on public.qa_loop_runs for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

comment on table public.qa_loop_runs is
  'SV-ENG-QA-HOURLY — every iteration of the hourly Dossie QA loop. Drives daily cost cap ($20/d), fix-ship cap (3/d), and scenario rotation telemetry.';
