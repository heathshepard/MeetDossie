-- 20260908b_guest_thread_reply_watch.sql
--
-- Guest-thread reply watching: cover replies to comments Heath leaves on
-- OTHER PEOPLE'S posts (the inverse of the 20260908 tc_reply_approval loop,
-- which only covers comments on Heath's own campaign posts). Heath is about
-- to leave 15-20 comments/day on third-party posts as a growth strategy;
-- when someone replies to him there, nothing currently sees it.
--
-- TABLE DECISION (no new store):
--   * Heath's outbound guest comments already land in comment_watchlist
--     (direction='heath_commented_on_others', written by the engage_posted_*
--     "Mark Posted" tap in api/telegram-webhook.js). That table was BUILT for
--     this — its header reserves "Part 3 (reply monitoring, NOT yet built)".
--     This migration adds the bookkeeping Part 3 needs.
--   * Detected replies-to-Heath go into tc_discovery_responses with
--     thread_role='guest' — that table already carries the ENTIRE
--     reply-approval lifecycle (reply_status state machine, dedupe on
--     (post_url, commenter_name, comment_hash), the drafting cron, the
--     tcreply_* Telegram callbacks, and the threaded poster). A third store
--     would duplicate all of that.
--   * fb_comment_replies is NOT extended: it belongs to the legacy veto-mode
--     pipeline (cron-auto-approve posts after a 10-minute timeout — a pattern
--     now forbidden: nothing may post without explicit approval) and its
--     poster uses Heath's personal Chrome profile with no verify/dedupe
--     machinery.
--
-- comment_watchlist single-value reply_author/reply_text/proposed_response
-- columns stay unused by this pipeline — a thread can draw N replies, each
-- needing its own approval lifecycle, which lives per-row in
-- tc_discovery_responses (watchlist_id links back).
--
-- Owner: Carter, 2026-09-08

-- ── comment_watchlist: Part 3 bookkeeping ───────────────────────────────────

ALTER TABLE public.comment_watchlist
  -- Snapshot of the ORIGINAL post's text, scraped on the first watch pass.
  -- Needed as Telegram context ("whose house is it") — third-party posts have
  -- no group_posts row to join.
  ADD COLUMN IF NOT EXISTS post_body TEXT,
  -- Permalink of HEATH'S comment in the thread (resolved by the watcher from
  -- the live DOM); its comment_id anchors reply detection.
  ADD COLUMN IF NOT EXISTS our_comment_permalink TEXT,
  -- Completed watch passes; drives the hot-window/long-tail cadence
  -- (same scheme as group_posts.harvest_count).
  ADD COLUMN IF NOT EXISTS check_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.comment_watchlist.post_body IS
  'Scraped snapshot of the third-party post''s text (best-effort, first watch pass). Context for reply drafting/Telegram only — not verbatim-language doctrine.';
COMMENT ON COLUMN public.comment_watchlist.our_comment_permalink IS
  'Facebook permalink of Heath''s own comment in this thread, resolved from the live DOM. Its comment_id is the parent id replies-to-Heath carry.';
COMMENT ON COLUMN public.comment_watchlist.check_count IS
  'Completed watch passes by scripts/watch-guest-thread-replies.js; drives the 45-min hot-window (first 48h) / 3-day long-tail cadence.';

-- Allow manually registered watches (comments Heath left outside the
-- engagement_queue pipeline — scripts/add-comment-watch.js).
ALTER TABLE public.comment_watchlist
  DROP CONSTRAINT IF EXISTS comment_watchlist_source_table_check;
ALTER TABLE public.comment_watchlist
  ADD CONSTRAINT comment_watchlist_source_table_check
  CHECK (source_table IN ('engagement_queue', 'group_posts', 'manual'));

-- ── tc_discovery_responses: guest-thread rows ───────────────────────────────

ALTER TABLE public.tc_discovery_responses
  -- 'host'  = comment on Heath's OWN post (original campaign loop)
  -- 'guest' = reply to a comment Heath left on SOMEONE ELSE'S post
  ADD COLUMN IF NOT EXISTS thread_role TEXT NOT NULL DEFAULT 'host'
    CHECK (thread_role IN ('host', 'guest')),
  ADD COLUMN IF NOT EXISTS watchlist_id UUID REFERENCES public.comment_watchlist(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.tc_discovery_responses.thread_role IS
  'host = comment on Heath''s own post; guest = reply to Heath''s comment on a third-party post (watchlist_id links the comment_watchlist row). Guest rows reuse the full reply_status lifecycle but get guest-tone drafts and are excluded from campaign analytics (question_id stays NULL).';
COMMENT ON COLUMN public.tc_discovery_responses.watchlist_id IS
  'For thread_role=guest: the comment_watchlist row (Heath''s outbound comment) this reply belongs to.';

CREATE INDEX IF NOT EXISTS idx_tc_discovery_responses_watchlist
  ON public.tc_discovery_responses (watchlist_id);
