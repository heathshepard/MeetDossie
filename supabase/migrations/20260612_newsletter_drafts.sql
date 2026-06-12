-- Newsletter drafts table — stores Thursday drafts for Heath's Friday approval workflow
-- (Cole, 2026-06-12)
--
-- Workflow:
-- 1. Thursday 8 AM: cron-weekly-newsletter-draft generates HTML/text draft
-- 2. Thursday 8 AM: Email + Telegram sent to Heath with preview
-- 3. Thursday 4 PM: cron-newsletter-draft-reminder pings if still pending
-- 4. Thursday evening: Heath replies APPROVE/EDIT/REGEN to Telegram
-- 5. Friday 10 AM: cron-weekly-newsletter reads draft status + sends (or regenerates if no draft exists)

create table if not exists public.newsletter_drafts (
  id uuid primary key default gen_random_uuid(),
  week_iso text not null,  -- e.g. '2026-W25' — ISO 8601 week format
  content_html text,
  content_text text,
  subject text,
  source_md_hash text,  -- SHA256 hash of WEEKLY-IMPROVEMENTS.md at draft time (change detection)
  status text not null default 'pending_review' check (status in ('pending_review','approved','sent','skipped')),
  generated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  approved_at timestamptz,
  sent_at timestamptz,
  edit_notes text,  -- free-form notes from Heath's EDIT command
  metadata jsonb,  -- hook for future extensibility
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Unique constraint: one draft per week
alter table public.newsletter_drafts add constraint newsletter_drafts_week_iso_key unique (week_iso);

-- Indexes for common queries
create index if not exists idx_newsletter_drafts_week_iso
  on public.newsletter_drafts (week_iso);
create index if not exists idx_newsletter_drafts_status
  on public.newsletter_drafts (status);
create index if not exists idx_newsletter_drafts_generated_at
  on public.newsletter_drafts (generated_at desc);

-- RLS: service_role only (crons write, no user reads)
alter table public.newsletter_drafts enable row level security;

drop policy if exists "service role full access" on public.newsletter_drafts;
create policy "service role full access"
  on public.newsletter_drafts for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
