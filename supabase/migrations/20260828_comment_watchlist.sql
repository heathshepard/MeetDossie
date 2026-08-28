-- ============================================================================
-- comment_watchlist -- unified thread-tracking for Sage's comment-opportunity
-- + reply-monitoring pipeline (both directions)
--
-- Built per Heath's spec 2026-08-28: human-in-the-loop only, nothing ever
-- auto-posts to Facebook. This table is populated ONLY after Heath has
-- confirmed (via Telegram "Mark Posted" tap) that he personally posted a
-- comment or an original post -- never on approval, never speculatively.
--
-- Covers BOTH directions explicitly:
--   'heath_commented_on_others' -- Heath left a comment on someone else's
--       post (sourced from engagement_queue, confirmed via the existing
--       engage_posted_<id> Telegram button in api/telegram-webhook.js).
--   'heath_own_post'            -- Heath's own original post in a group
--       (sourced from group_posts, confirmed automatically when
--       fb-group-poster.js marks the row status='posted').
--
-- Part 3 (reply monitoring, NOT yet built -- gated on confirming Facebook's
-- Notifications page actually surfaces group-comment replies) will poll
-- against rows here with status='watching', update last_checked_at on every
-- poll pass, and flip status='reply_detected' when a matching notification
-- shows up. reply_detected_at / heath_responded_at exist now so that SLA
-- math (detection-time -> Heath's actual response-time, target: within a
-- 1-hour window) can be measured for real once Part 3 ships, without a
-- second migration.
--
-- Owner: Sage, 2026-08-28
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.comment_watchlist (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What we're watching
  thread_url            TEXT NOT NULL,
  group_name            TEXT,
  post_author           TEXT,             -- author of the ORIGINAL post/thread
                                           -- (not Heath, unless direction = 'heath_own_post')
  direction             TEXT NOT NULL
                        CHECK (direction IN ('heath_commented_on_others', 'heath_own_post')),
  our_text              TEXT,             -- Heath's actual comment/post text, as posted

  -- Provenance -- link back to the row that generated this watch entry
  source_table          TEXT NOT NULL
                        CHECK (source_table IN ('engagement_queue', 'group_posts')),
  source_id             UUID,

  posted_at             TIMESTAMPTZ NOT NULL,

  -- Part 3 (reply monitoring) fields -- unused until that ships
  status                TEXT NOT NULL DEFAULT 'watching'
                        CHECK (status IN ('watching', 'reply_detected', 'stale', 'archived')),
  last_checked_at       TIMESTAMPTZ,
  reply_detected_at     TIMESTAMPTZ,
  reply_author          TEXT,
  reply_text            TEXT,
  proposed_response     TEXT,
  heath_responded_at    TIMESTAMPTZ,      -- set when Heath taps "I responded" (Part 3 confirm button)

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comment_watchlist_status
  ON public.comment_watchlist (status, last_checked_at);

CREATE INDEX IF NOT EXISTS idx_comment_watchlist_source
  ON public.comment_watchlist (source_table, source_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_watchlist_source_unique
  ON public.comment_watchlist (source_table, source_id)
  WHERE source_id IS NOT NULL;

COMMENT ON TABLE public.comment_watchlist IS
  'Threads Heath has actually posted to (comment on someone else''s post, or his own original post), confirmed via Telegram tap -- never speculative. Feeds Part 3 reply-monitoring polling once built. Nothing in this pipeline auto-posts to Facebook at any stage.';
COMMENT ON COLUMN public.comment_watchlist.heath_responded_at IS
  'When Heath confirms (Telegram button) that he actually replied to a detected reply -- the real end-of-SLA timestamp, not an assumption.';

ALTER TABLE public.comment_watchlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY comment_watchlist_service_all ON public.comment_watchlist
  FOR ALL USING (true) WITH CHECK (true);
