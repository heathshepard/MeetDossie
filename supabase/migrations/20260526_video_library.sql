create table if not exists public.video_library (
  id text primary key,
  path text,
  type text,
  topic text,
  produced_date date,
  status text default 'ready',
  platforms text[],
  caption text,
  telegram_message_id bigint,
  supabase_url text,
  posted_date timestamptz,
  created_at timestamptz default now()
);
