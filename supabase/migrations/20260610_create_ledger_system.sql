-- Ledger system for Shepard Ventures accounting
-- Tracks income (Stripe subscriptions, one-time), expenses (SaaS, professional services), and runway

-- Ledger entries: all financial transactions (income, expense, adjustment)
create table if not exists public.ledger_entries (
  id uuid primary key default uuid_generate_v4(),
  date date not null default current_date,
  type text not null check (type in ('income', 'expense', 'adjustment')),
  amount decimal(12,2) not null,
  currency text not null default 'USD' check (currency in ('USD', 'EUR')),
  category text not null,
  vendor text,
  description text,
  entity text not null default 'shepard_ventures' check (entity in ('shepard_ventures', 'dossie_llc', 'personal_agent_product')),
  source text not null check (source in ('stripe', 'mercury', 'manual', 'anthropic', 'webhook')),
  evidence_url text,
  notes text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  created_by uuid references auth.users on delete set null
);

-- RLS: Heath can read all, only admins can write
alter table public.ledger_entries enable row level security;

create policy "Users can read own ledger if admin"
  on public.ledger_entries for select
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
      and profiles.email = 'heath.shepard@kw.com'
    )
  );

create policy "Only Heath can insert ledger entries"
  on public.ledger_entries for insert
  with check (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
      and profiles.email = 'heath.shepard@kw.com'
    )
  );

-- Recurring subscriptions: auto-generate expense rows on renewal day
create table if not exists public.recurring_subscriptions (
  id uuid primary key default uuid_generate_v4(),
  vendor text not null unique,
  category text not null,
  monthly_cost decimal(12,2) not null,
  currency text default 'USD',
  renewal_day integer not null default 1 check (renewal_day >= 1 and renewal_day <= 31),
  status text not null default 'active' check (status in ('active', 'paused', 'canceled')),
  entity text not null default 'dossie_llc',
  notes text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

alter table public.recurring_subscriptions enable row level security;

create policy "Only Heath can manage recurring subscriptions"
  on public.recurring_subscriptions for all
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
      and profiles.email = 'heath.shepard@kw.com'
    )
  );

-- Index for common queries
create index if not exists idx_ledger_date on public.ledger_entries(date desc);
create index if not exists idx_ledger_entity_type on public.ledger_entries(entity, type);
create index if not exists idx_ledger_category on public.ledger_entries(category);

-- Insert initial recurring subscriptions (from CLAUDE.md Section 2.5)
insert into public.recurring_subscriptions (vendor, category, monthly_cost, renewal_day, entity, status)
values
  ('Zernio', 'Social Media', 18.00, 1, 'dossie_llc', 'active'),
  ('Submagic', 'Video Production', 12.00, 1, 'dossie_llc', 'active'),
  ('Hiscox E&O Insurance', 'Professional Liability', 33.32, 1, 'shepard_ventures', 'active')
on conflict (vendor) do nothing;
