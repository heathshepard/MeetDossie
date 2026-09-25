-- ============================================================================
-- ZERNIO COMMENT ENGINE (Atlas, 2026-09-25)
--
-- WHY THIS EXISTS
-- The comment/reply engine ran through the DossieBot Chrome profile, which has
-- been logged out of Facebook and LinkedIn for 9 days. Heath: "I can't have
-- this cookies-are-gone bullshit or it just falls apart."
--
-- It was worse than that. api/cron-comment-monitor.js has fired every 15 min
-- since 2026-07-08 and ingested ZERO comments in its entire life, because it
-- filtered `social_posts.zernio_post_id=not.is.null` and that column is NULL on
-- every recent posted row. It reported last_status='ok' in 66ms, forever.
-- Meanwhile GET /v1/inbox/comments shows 13 of our posts carrying real,
-- unanswered comments from real people right now.
--
-- The fix is not a better filter. It is to stop asking our own bookkeeping
-- which posts might have comments and ask the PLATFORM instead:
-- GET /v1/inbox/comments enumerates every post with comments across every
-- connected account, so a post we never recorded still cannot hide a comment.
--
-- Three concerns, three tables:
--   1. social_comment_replies  - EXTENDED. Inbound comments on OUR posts.
--   2. video_comment_automations - NEW. The keyword ledger. A keyword is a
--      property of the video, not a separate chore, and it is UNIQUE so a
--      lead is attributable to the video that produced it.
--   3. comment_dm_leads        - NEW. Who asked for the asset. That's the list.
--
-- NOTE ON engagement_candidates: deliberately NOT reused. That table is the
-- OUTBOUND side (comments Heath initiates on other people's posts, found by
-- the group scanner: post_url, relevance_score, comment_draft). Inbound
-- comments on our own posts are a different object with a different lifecycle,
-- and social_comment_replies already models exactly that.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. social_comment_replies -- inbound comments on our own posts
-- ---------------------------------------------------------------------------
-- Pre-existing table (created 2026-07-08, never written to). Additive only.

-- Zernio account that owns the post. Required on EVERY comment read and write
-- (GET/POST /v1/inbox/comments/{postId} both demand accountId), and the old
-- schema had nowhere to keep it, so every ingested row was unreplyable.
alter table social_comment_replies add column if not exists account_id text;

-- Thread shape. parent_comment_id is null for a top-level comment.
alter table social_comment_replies add column if not exists parent_comment_id text;
alter table social_comment_replies add column if not exists comment_url text;
alter table social_comment_replies add column if not exists commenter_platform_id text;
alter table social_comment_replies add column if not exists commenter_name text;
alter table social_comment_replies add column if not exists comment_created_at timestamptz;

-- Post context, so a draft can be written without re-fetching the post.
alter table social_comment_replies add column if not exists post_excerpt text;
alter table social_comment_replies add column if not exists post_permalink text;

-- Risk classification (scripts/_lib/auto-reply-risk-classifier.js).
-- fb-engagement-thread-close-policy.md: a thread that reaches a pricing
-- question or a demo request is escalated to Heath and NEVER auto-replied.
alter table social_comment_replies add column if not exists risk_category text;
alter table social_comment_replies add column if not exists risk_confidence text;
alter table social_comment_replies add column if not exists escalated boolean not null default false;
alter table social_comment_replies add column if not exists escalation_reason text;

-- Content gates (scripts/_lib/auto-reply-content-gates.js + heath-voice-guard).
alter table social_comment_replies add column if not exists gate_failures jsonb;

-- Approval trail.
alter table social_comment_replies add column if not exists telegram_message_id bigint;
alter table social_comment_replies add column if not exists telegram_sent_at timestamptz;
alter table social_comment_replies add column if not exists approved_at timestamptz;
alter table social_comment_replies add column if not exists approved_by text;

-- Thread-close policy (fb-engagement-thread-close-policy.md): the close
-- decision is a STATUS WRITE, not a judgment call at query time, so a closed
-- thread actually leaves the outstanding-reply list. The reason goes on its
-- own column, never smuggled into an error field -- that is exactly how 6
-- manually-answered rows read as falsely outstanding on 2026-09-08.
alter table social_comment_replies add column if not exists thread_status text not null default 'open';
alter table social_comment_replies add column if not exists thread_closed_at timestamptz;
alter table social_comment_replies add column if not exists thread_close_reason text;

alter table social_comment_replies add column if not exists attempt_count integer not null default 0;
alter table social_comment_replies add column if not exists last_seen_at timestamptz;
alter table social_comment_replies add column if not exists ingested_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'social_comment_replies_thread_status_chk'
  ) then
    alter table social_comment_replies
      add constraint social_comment_replies_thread_status_chk
      check (thread_status in ('open', 'closed'));
  end if;
end $$;

-- NOTHING MAY BE LOST is the whole point, and the only mechanical guarantee of
-- it is that re-ingesting the same comment can never create a second row and
-- can never fail the batch. One comment id per platform, enforced in the DB so
-- the ingest cron can use a plain upsert.
create unique index if not exists social_comment_replies_platform_comment_uniq
  on social_comment_replies (platform, comment_external_id);

-- The outstanding-reply query (feedback_surface-outstanding-replies-unprompted).
create index if not exists social_comment_replies_outstanding_idx
  on social_comment_replies (thread_status, reply_status, comment_created_at desc);


-- ---------------------------------------------------------------------------
-- 2. video_comment_automations -- the keyword ledger
-- ---------------------------------------------------------------------------
-- Heath: "as we create videos and want these keywords we have to constantly be
-- updating our keywords for the next relevant video."
--
-- So the keyword is declared ON THE VIDEO and this table is derived state, not
-- a thing anyone maintains by hand. One row per (video, platform account).
-- Lifecycle: pending -> armed -> (paused) -> retired.
create table if not exists video_comment_automations (
  id                   uuid primary key default gen_random_uuid(),

  -- The content that owns this keyword.
  video_library_id     text not null references video_library(id) on delete cascade,

  -- THE keyword. Lowercased. Unique across every video, forever -- including
  -- retired ones, which is deliberate: a keyword is a permanent attribution
  -- token. If 'TREC' could be recycled onto a second video, every lead it ever
  -- produced becomes ambiguous. Collisions are refused, never overwritten.
  keyword              text not null,

  -- Where it is armed. Comment-to-DM is Instagram/Facebook ONLY (verified
  -- against the live API 2026-09-25: platform is `one of: instagram, facebook`).
  platform             text not null check (platform in ('instagram', 'facebook')),
  account_id           text not null,
  platform_post_id     text,
  zernio_automation_id text,

  -- What gets delivered.
  dm_message           text not null,
  asset_url            text,
  asset_button_label   text not null default 'Get the one-pager',

  -- Matching. 'word' + typoTolerance is the sane default for a single-token
  -- keyword: 'contains' would fire TREC on the word "trecherous" and on every
  -- comment that merely mentions TREC in passing.
  match_mode           text not null default 'word' check (match_mode in ('exact', 'contains', 'word')),
  typo_tolerance       boolean not null default true,
  exclude_keywords     text[] not null default '{}',

  status               text not null default 'pending'
    check (status in ('pending', 'armed', 'paused', 'retired', 'error')),
  armed_at             timestamptz,
  paused_at            timestamptz,
  retired_at           timestamptz,
  retire_reason        text,
  last_error           text,
  last_synced_at       timestamptz,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- The uniqueness guarantee, in the DB rather than in a code path someone can
-- forget to call. Case-insensitive because Zernio matches case-insensitively.
create unique index if not exists video_comment_automations_keyword_uniq
  on video_comment_automations (lower(keyword));

-- One automation per (video, account) -- re-running the sync updates in place
-- instead of stacking duplicates. The live API accepts a second automation on
-- the same post even though the docs say it will not (probed 2026-09-25), so
-- this constraint is ours to hold, not Zernio's.
create unique index if not exists video_comment_automations_video_account_uniq
  on video_comment_automations (video_library_id, account_id);

create index if not exists video_comment_automations_status_idx
  on video_comment_automations (status);


-- The declaration side: the keyword lives ON the video record, which is the
-- thing a human already touches when producing content. Nobody edits the
-- automation table; they set these two fields and the sync does the rest.
alter table video_library add column if not exists dm_keyword text;
alter table video_library add column if not exists dm_asset_url text;
alter table video_library add column if not exists dm_message text;

-- Same permanent-attribution rule at the declaration site, so a collision is
-- caught when someone TYPES the duplicate keyword, not later at arm time.
create unique index if not exists video_library_dm_keyword_uniq
  on video_library (lower(dm_keyword)) where dm_keyword is not null;


-- ---------------------------------------------------------------------------
-- 3. comment_dm_leads -- who asked for the asset
-- ---------------------------------------------------------------------------
-- "A DM'd asset is worthless if we don't record who asked."
--
-- Not waitlist (email-only: id/created_at/email/source -- a commenter gives us
-- a platform handle and no email, so every row would have a null in the only
-- column that matters). Not calculator_signups (email + TREC contract_data +
-- deadlines; nothing about it fits). New table.
create table if not exists comment_dm_leads (
  id                    uuid primary key default gen_random_uuid(),

  -- Idempotency: Zernio's own trigger-log row id. The lead sync re-reads the
  -- same log pages every run; this is what makes that safe.
  zernio_log_id         text not null unique,

  platform              text not null,
  account_id            text,

  -- Who asked.
  commenter_platform_id text,
  commenter_name        text,
  commenter_handle      text,
  is_follower           boolean,
  follower_count        integer,

  -- What they asked for, and which video earned it. Both recorded, because
  -- keyword alone is the attribution token but the video is what we optimize.
  keyword               text,
  video_library_id      text references video_library(id) on delete set null,
  automation_id         uuid references video_comment_automations(id) on delete set null,
  zernio_automation_id  text,

  comment_text          text,
  comment_external_id   text,

  -- Did the asset actually reach them. 'sent' is Zernio's word; delivery and
  -- read are separate signals it may or may not have.
  dm_status             text,
  dm_error              text,
  delivered             boolean,
  read                  boolean,

  triggered_at          timestamptz,
  synced_at             timestamptz not null default now(),
  created_at            timestamptz not null default now()
);

create index if not exists comment_dm_leads_keyword_idx on comment_dm_leads (keyword);
create index if not exists comment_dm_leads_video_idx   on comment_dm_leads (video_library_id);
create index if not exists comment_dm_leads_time_idx    on comment_dm_leads (triggered_at desc);


-- ---------------------------------------------------------------------------
-- 4. Kill switches -- default OFF
-- ---------------------------------------------------------------------------
-- Nothing in this migration may talk to a real person until Heath flips these.
-- Creating a live comment-automation is a publish-class action: verified
-- 2026-09-25 that POST /v1/comment-automations SILENTLY IGNORES isActive:false
-- and returns isActive:true, so an automation is LIVE the instant it is
-- created. The arming path therefore refuses to run at all unless the flag
-- below is on, and PATCHes isActive:false immediately when it creates one in
-- paused mode.
insert into ops_flags (key, enabled, reason, updated_by) values
  ('zernio_comment_replies',
   false,
   'Auto-posting drafted replies to real commenters via the Zernio API. OFF until Heath turns it on. Drafting + Telegram approval run regardless; this flag only controls whether an APPROVED reply is actually posted.',
   'atlas'),
  ('zernio_comment_automations',
   false,
   'STAGE 1. Allows the sync to CREATE comment-to-DM automations at Zernio, in a PAUSED state. OFF until Heath turns it on; with it off the sync is report-only and creates nothing.',
   'atlas'),
  ('zernio_comment_automations_live',
   false,
   'STAGE 2. Allows created automations to be ARMED (isActive true) so they DM real people who comment the keyword. Requires stage 1. Two flags because POST /v1/comment-automations ignores isActive:false and returns an ACTIVE automation - creating one is itself a publish-class action, so creating and arming are separately consented.',
   'atlas')
on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- 5. Outcome expectations -- a zero-output run must be VISIBLE
-- ---------------------------------------------------------------------------
-- Measured against the artifacts themselves, never against a job status flag.
-- This is the whole lesson of 20260925_outcome_monitor.sql, and this pipeline
-- is the exhibit: cron-comment-monitor said 'ok' for 79 straight days.
insert into outcome_expectations
  (key, pipeline, label, source_table, source_filters, time_column,
   window_mode, window_hours, min_count, classifiers, remediations,
   remediation_mode, severity, grace_hours)
values
  ('comment_ingest_weekly',
   'zernio-comments',
   'Inbound comments ingested from the Zernio API',
   'social_comment_replies', '{}'::jsonb, 'ingested_at',
   'recent', 168, 1, '{}', '{}', 'safe', 'warn', 24)
on conflict (key) do nothing;
