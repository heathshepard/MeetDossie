-- ============================================================================
-- COMMENT-REPLY AUTHENTICITY GATES (Atlas, 2026-09-29)
--
-- WHY THIS EXISTS
-- api/cron-publish-comment-replies.js's first dry run produced 6 eligible
-- replies and ALL SIX went to one LinkedIn account ("Antonio Edwards"), who
-- produced 10 of the table's 39 lifetime comments in 10 days -- every one a
-- flawless on-message setup for Dossie's pitch. No other commenter in the
-- table's history exceeds 2. Almost certainly an engagement bot.
-- See memory feedback_authentic-engagement-gates.md for the full story and
-- Heath's explicit constraint: the gates must never silence real
-- conversation, only the bot pattern.
--
-- This migration adds the ONE piece of persistent state the new gates need
-- that doesn't already exist on social_comment_replies: whether a commenter
-- has been manually verified after using their one unverified free reply.
-- Everything else (cooldown, concentration) is computed live from
-- social_comment_replies at publish time -- no new state needed for those.
-- ============================================================================

create table if not exists social_commenter_trust (
  -- commenter_platform_id when present (LinkedIn/Instagram/Facebook all
  -- populate it), else a platform-scoped commenter_handle fallback. Never
  -- commenter_name -- display names collide (two different platform ids have
  -- both shown up as "sheshepard" in this table already).
  commenter_key         text primary key,

  platform              text,
  commenter_name        text,

  -- The one free reply an unverified commenter gets before they need a
  -- one-time human check (gate 3, feedback_authentic-engagement-gates.md).
  free_reply_used_at    timestamptz,
  free_reply_id         uuid references social_comment_replies(id) on delete set null,

  -- Heath's one-time check clears this permanently for that commenter.
  verified              boolean not null default false,
  verified_at           timestamptz,
  verified_by           text,

  -- Concentration freeze lands here too, so a single table answers "why is
  -- this account paused" regardless of which gate did it.
  concentration_frozen_at  timestamptz,
  concentration_pct        numeric,
  concentration_sample     integer,

  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists social_commenter_trust_platform_idx
  on social_commenter_trust (platform);

-- Cheap lookups for the cooldown + concentration gates, which both filter
-- social_comment_replies by time window and need the commenter identity
-- columns in the select list. Neither is a new query SHAPE (the table is
-- tiny today) but the index costs nothing and saves a rewrite when volume
-- grows past "fits in one unindexed scan."
create index if not exists social_comment_replies_commenter_platform_id_idx
  on social_comment_replies (commenter_platform_id);
create index if not exists social_comment_replies_posted_at_idx
  on social_comment_replies (posted_at) where posted_at is not null;
