-- ============================================================================
-- COMMENT MONITOR RESUMABLE DISCOVERY CURSOR (Atlas, 2026-09-30)
--
-- WHY THIS EXISTS
-- cron-comment-monitor's own internal deadline (15s, set 2026-09-29 to stop
-- it taking down the whole every15 dispatcher) was hit mid-scan on a live
-- run. The discovery call (GET /v1/inbox/comments) always started over from
-- cursor=null, so every single tick re-walked the SAME first few pages and
-- NEVER reached posts further back -- a truncating scan that always starts
-- from the same place always misses the same tail.
--
-- Measured live against prod 2026-09-30 (see api/cron-comment-monitor.js and
-- the PR description for the full numbers): a full discovery sweep of the
-- 3-year lookback window takes ~16-17 pages / ~80s cold, and finds 29 posts
-- carrying comments. That's now comfortably inside cron-comment-monitor's
-- new home (every20, 300s budget) in a single tick on a normal day -- but
-- Zernio's own per-page latency is measured to vary 200ms-14s, so a bad day
-- (rate limiting, an account outage, a slow upstream) can still blow any
-- fixed deadline. This table is what turns "bounded" into "resumable": a run
-- that gets cut off continues next tick from exactly where it stopped,
-- instead of re-scanning the same head of the list forever.
--
-- ONE ROW (id=1). Singleton by design -- there is exactly one discovery
-- sweep in flight at a time for this job.
--   discovery_cursor      -- Zernio's opaque pagination cursor to resume
--                             from. NULL means "start a fresh sweep."
--   discovery_since       -- the `since` ISO timestamp the CURRENT (or most
--                             recently completed) sweep is pinned to. Fixed
--                             for the whole sweep and reused verbatim on
--                             every resumed page -- a cursor issued under one
--                             `since` value replayed against a different one
--                             is unproven territory against the live API and
--                             not worth risking silently skipping pages.
--   sweep_started_at       -- when the current (or most recent) sweep began.
--   last_sweep_completed_at -- last time discovery reached hasMore=false,
--                             i.e. a full pass over the whole lookback window
--                             was proven complete. NULL until the first one
--                             finishes. This is the coverage proof: if this
--                             keeps advancing every few ticks, nothing in the
--                             lookback window can stay permanently unseen.
--   posts_seen_this_sweep  -- running count of unique posts discovered so
--                             far in the CURRENT sweep. Reset to 0 when a new
--                             sweep starts.
--   total_posts_last_sweep -- count from the most recently COMPLETED sweep,
--                             kept for monitoring / regression comparison.
-- ============================================================================

create table if not exists cron_comment_monitor_state (
  id                       smallint primary key default 1,
  discovery_cursor         text,
  discovery_since          text,
  sweep_started_at         timestamptz,
  last_sweep_completed_at  timestamptz,
  posts_seen_this_sweep    integer not null default 0,
  total_posts_last_sweep   integer,
  updated_at               timestamptz not null default now(),

  constraint cron_comment_monitor_state_singleton check (id = 1)
);

insert into cron_comment_monitor_state (id, discovery_cursor, discovery_since, sweep_started_at)
values (1, null, null, now())
on conflict (id) do nothing;
