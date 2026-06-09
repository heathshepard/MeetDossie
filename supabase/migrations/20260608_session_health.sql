-- Tracks browser session-cookie freshness for our Playwright automations.
-- Read/written by api/cron-cookie-health-check.js (service role only).

create table if not exists public.session_health (
  id uuid primary key default gen_random_uuid(),
  site_name text not null unique,
  last_renewed_at timestamptz,
  expires_at timestamptz,
  status text not null default 'unknown', -- healthy | expiring | expired | missing | unknown
  notes text,
  last_checked_at timestamptz not null default now()
);

alter table public.session_health enable row level security;

drop policy if exists session_health_service_role on public.session_health;
create policy session_health_service_role on public.session_health
  for all
  to service_role
  using (true)
  with check (true);

create index if not exists session_health_site_idx on public.session_health(site_name);
