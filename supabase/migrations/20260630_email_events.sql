-- Create email_events table for cold-email metrics tracking
-- Tracks delivery, open, click, bounce, and complaint events from Resend webhooks

create table if not exists public.email_events (
  id uuid primary key default gen_random_uuid(),
  resend_email_id text,
  recipient_email text,
  event_type text not null, -- 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained'
  event_ts timestamptz not null,
  url_clicked text,
  campaign_id text,
  batch_id text,
  created_at timestamptz not null default now()
);

-- Indexes for fast querying on recipient_email, event_type, and campaign_id
create index if not exists idx_email_events_recipient on public.email_events(recipient_email);
create index if not exists idx_email_events_type on public.email_events(event_type);
create index if not exists idx_email_events_campaign on public.email_events(campaign_id);
create index if not exists idx_email_events_batch on public.email_events(batch_id);
create index if not exists idx_email_events_ts on public.email_events(event_ts);

-- Enable RLS (no row-level security by default; only admin reads via service role)
alter table public.email_events enable row level security;

-- Deny all by default
create policy "Deny all access by default" on public.email_events
  as restrictive
  for all
  to authenticated, anon
  using (false);
