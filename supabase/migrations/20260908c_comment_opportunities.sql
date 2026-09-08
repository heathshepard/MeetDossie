-- 20260908c_comment_opportunities.sql
--
-- Daily comment-opportunity finder: makes group engagement CONTINUOUS instead
-- of one-off. Today an agent hand-found 16 opportunities; nothing finds new
-- ones tomorrow. This table is the pipeline's spine.
--
-- Pipeline (all pieces reuse proven machinery — nothing rebuilt):
--   scripts/fb-comment-hunt-daily.js      scans the genuinely active groups
--       once/day with the End-key stepped-scan technique from the 2026-09-08
--       hunt (FB virtualizes feed text; only per-step extraction works) and
--       inserts candidate rows at status='found'.
--   api/cron-comment-opp-approval.js      scores each candidate (wide bar per
--       Heath 2026-09-08: "can he say something genuinely useful here?" — not
--       just TREC/contracts), drafts a comment in Heath's voice (never Dossie,
--       never a link, never a pitch), and Telegrams the BEST ones for
--       Approve / Edit / Skip (tcreply_* pattern, oppc_* callbacks).
--   scripts/fb-comment-opp-poster.js      posts APPROVED comments only, one
--       per run, 45-60 min varied spacing, verifies by re-rendering the
--       thread, records the thread in comment_watchlist so the guest-thread
--       watcher catches replies. Halts everything on any warning sign.
--
-- Lifecycle (status):
--   'found'        scanner inserted it; scoring/drafting pending or done
--                  (score/comment_draft fill in-place; a telegram-gate-
--                  suppressed send leaves the row here — NEVER 'notified')
--   'rejected'     scored below the bar — the honest comment would be filler
--   'expired'      >48h old before Heath ever saw it; commenting late on a
--                  dead thread reads as bot behavior
--   'notified'     approval message DELIVERED to Heath (suppression-checked)
--   'approved'     Heath tapped Approve (comment_final = draft) or replied
--                  with an edit (comment_final = his text)
--   'skipped'      Heath tapped Skip, or the poster found Heath had already
--                  commented on the thread. Terminal.
--   'posting'      claimed by the local poster (atomic status-guarded PATCH
--                  from 'approved' — the double-post lock)
--   'posted'       comment confirmed live by re-reading the thread
--   'post_failed'  submit or verify failed. Terminal — NEVER auto-retried
--                  (a verify failure can mean the comment DID post).
--
-- One comment per post, EVER: post_url is UNIQUE, (group_url, post_hash) is
-- UNIQUE, and the poster additionally refuses any post_url already present in
-- comment_watchlist or re-renders showing an existing Heath comment.
--
-- Owner: Carter, 2026-09-08

CREATE TABLE IF NOT EXISTS public.comment_opportunities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Where it was found
  group_key           TEXT,
  group_name          TEXT NOT NULL,
  group_url           TEXT NOT NULL,
  post_url            TEXT NOT NULL,     -- required: no permalink = can't post = not an opportunity
  author_name         TEXT,

  -- The post itself (verbatim; scoring context, not landing-copy doctrine)
  post_text           TEXT NOT NULL,
  post_hash           TEXT GENERATED ALWAYS AS (md5(btrim(regexp_replace(post_text, '\s+', ' ', 'g')))) STORED,
  post_age_raw        TEXT,              -- FB's rendered age verbatim ("3h", "Yesterday")
  comment_count       INTEGER,           -- parsed best-effort; fewer = Heath's comment gets seen

  found_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Scoring (cron-comment-opp-approval)
  score               INTEGER CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  score_reasons       TEXT,

  -- Lifecycle
  status              TEXT NOT NULL DEFAULT 'found'
                      CHECK (status IN ('found','rejected','expired','notified','approved',
                                        'skipped','posting','posted','post_failed')),
  comment_draft       TEXT,              -- AI draft, Heath's voice, zero pitch
  comment_final       TEXT,              -- what actually posts: draft on Approve, Heath's text on Edit
  notified_at         TIMESTAMPTZ,
  telegram_message_id TEXT,
  approved_at         TIMESTAMPTZ,
  posted_at           TIMESTAMPTZ,
  error               TEXT,
  watchlist_id        UUID REFERENCES public.comment_watchlist(id) ON DELETE SET NULL,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One comment per post, ever — layer 1 (layers 2+3 live in the poster:
-- comment_watchlist thread check + live already-commented DOM check).
CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_opportunities_post_url
  ON public.comment_opportunities (post_url);

-- Same post re-scraped under a permalink variant still dedupes on content.
CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_opportunities_group_hash
  ON public.comment_opportunities (group_url, post_hash);

CREATE INDEX IF NOT EXISTS idx_comment_opportunities_status
  ON public.comment_opportunities (status, found_at);

COMMENT ON TABLE public.comment_opportunities IS
  'Daily comment-opportunity pipeline (find -> score -> draft -> Heath approves in Telegram -> paced verified post -> comment_watchlist). Nothing ever posts without status=approved, which only Heath''s explicit Telegram tap/edit can set. post_failed is terminal — never auto-retried.';
COMMENT ON COLUMN public.comment_opportunities.comment_final IS
  'The text that actually posts: the draft on plain Approve, or Heath''s edited text from the Telegram reply flow.';

ALTER TABLE public.comment_opportunities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS comment_opportunities_service_all ON public.comment_opportunities;
CREATE POLICY comment_opportunities_service_all ON public.comment_opportunities
  FOR ALL USING (true) WITH CHECK (true);

-- ── comment_watchlist: allow this pipeline as a provenance source ────────────
-- Posted comments register here so scripts/watch-guest-thread-replies.js
-- catches replies-to-Heath in these threads (same Part-3 loop as the
-- engagement_queue "Mark Posted" path).

ALTER TABLE public.comment_watchlist
  DROP CONSTRAINT IF EXISTS comment_watchlist_source_table_check;
ALTER TABLE public.comment_watchlist
  ADD CONSTRAINT comment_watchlist_source_table_check
  CHECK (source_table IN ('engagement_queue', 'group_posts', 'manual', 'comment_opportunities'));
