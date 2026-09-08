'use strict';

// One-time migration: create public.comment_opportunities (daily
// comment-opportunity pipeline) + extend comment_watchlist's source_table
// CHECK. Safe to re-run — IF NOT EXISTS / DROP-then-ADD throughout, no data
// touched.
//
// DDL isn't reachable through PostgREST, so this runs directly against
// Postgres via api/_lib/pg-admin.js (POSTGRES_URL_NON_POOLING). Mirrors
// supabase/migrations/20260908c_comment_opportunities.sql and the exact
// pattern of api/admin-migrate-comment-watchlist.js. Local POSTGRES_* env is
// write-only ([SENSITIVE]) so the migration can only be applied from a
// deployed environment:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://<preview-or-prod>/api/admin-migrate-comment-opportunities
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-08

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
CREATE TABLE IF NOT EXISTS public.comment_opportunities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_key           TEXT,
  group_name          TEXT NOT NULL,
  group_url           TEXT NOT NULL,
  post_url            TEXT NOT NULL,
  author_name         TEXT,
  post_text           TEXT NOT NULL,
  post_hash           TEXT GENERATED ALWAYS AS (md5(btrim(regexp_replace(post_text, '\\s+', ' ', 'g')))) STORED,
  post_age_raw        TEXT,
  comment_count       INTEGER,
  found_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  score               INTEGER CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  score_reasons       TEXT,
  status              TEXT NOT NULL DEFAULT 'found'
                      CHECK (status IN ('found','rejected','expired','notified','approved',
                                        'skipped','posting','posted','post_failed')),
  comment_draft       TEXT,
  comment_final       TEXT,
  notified_at         TIMESTAMPTZ,
  telegram_message_id TEXT,
  approved_at         TIMESTAMPTZ,
  posted_at           TIMESTAMPTZ,
  error               TEXT,
  watchlist_id        UUID REFERENCES public.comment_watchlist(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_opportunities_post_url
  ON public.comment_opportunities (post_url);

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

ALTER TABLE public.comment_watchlist
  DROP CONSTRAINT IF EXISTS comment_watchlist_source_table_check;
ALTER TABLE public.comment_watchlist
  ADD CONSTRAINT comment_watchlist_source_table_check
  CHECK (source_table IN ('engagement_queue', 'group_posts', 'manual', 'comment_opportunities'));
`;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    await runAdminSql(SQL);
    return res.status(200).json({ ok: true, migrated: 'comment_opportunities + comment_watchlist source_table check' });
  } catch (err) {
    console.error('[admin-migrate-comment-opportunities]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
