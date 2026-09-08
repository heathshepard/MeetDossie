'use strict';

// One-time migration: guest-thread reply-watch columns on comment_watchlist
// + tc_discovery_responses. Full design commentary (incl. the table decision)
// in supabase/migrations/20260908b_guest_thread_reply_watch.sql — keep the
// two in sync.
//
// Safe to re-run — ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS;
// the CHECK-constraint swap drops-then-adds by name.
//
// This route exists because POSTGRES_URL_NON_POOLING is a write-only
// ("Sensitive") Vercel var, so DDL cannot be run from a local shell — same
// reason the admin-migrate-* siblings exist.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-08 (guest-thread reply watcher)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.comment_watchlist
  ADD COLUMN IF NOT EXISTS post_body TEXT,
  ADD COLUMN IF NOT EXISTS our_comment_permalink TEXT,
  ADD COLUMN IF NOT EXISTS check_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.comment_watchlist.post_body IS
  'Scraped snapshot of the third-party post''s text (best-effort, first watch pass). Context for reply drafting/Telegram only — not verbatim-language doctrine.';
COMMENT ON COLUMN public.comment_watchlist.our_comment_permalink IS
  'Facebook permalink of Heath''s own comment in this thread, resolved from the live DOM. Its comment_id is the parent id replies-to-Heath carry.';
COMMENT ON COLUMN public.comment_watchlist.check_count IS
  'Completed watch passes by scripts/watch-guest-thread-replies.js; drives the 45-min hot-window (first 48h) / 3-day long-tail cadence.';

ALTER TABLE public.comment_watchlist
  DROP CONSTRAINT IF EXISTS comment_watchlist_source_table_check;
ALTER TABLE public.comment_watchlist
  ADD CONSTRAINT comment_watchlist_source_table_check
  CHECK (source_table IN ('engagement_queue', 'group_posts', 'manual'));

ALTER TABLE public.tc_discovery_responses
  ADD COLUMN IF NOT EXISTS thread_role TEXT NOT NULL DEFAULT 'host'
    CHECK (thread_role IN ('host', 'guest')),
  ADD COLUMN IF NOT EXISTS watchlist_id UUID REFERENCES public.comment_watchlist(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.tc_discovery_responses.thread_role IS
  'host = comment on Heath''s own post; guest = reply to Heath''s comment on a third-party post (watchlist_id links the comment_watchlist row). Guest rows reuse the full reply_status lifecycle but get guest-tone drafts and are excluded from campaign analytics (question_id stays NULL).';
COMMENT ON COLUMN public.tc_discovery_responses.watchlist_id IS
  'For thread_role=guest: the comment_watchlist row (Heath''s outbound comment) this reply belongs to.';

CREATE INDEX IF NOT EXISTS idx_tc_discovery_responses_watchlist
  ON public.tc_discovery_responses (watchlist_id);
`;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(SQL);
    return res.status(200).json({ ok: true, message: 'guest-thread reply-watch columns ready' });
  } catch (err) {
    console.error('[admin-migrate-guest-thread-replies]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
