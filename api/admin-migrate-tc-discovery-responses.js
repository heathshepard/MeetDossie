// One-time migration: create public.tc_discovery_responses (verbatim
// response capture for the TC discovery campaign, docs/TC-DISCOVERY-CAMPAIGN.md
// "2026-09-07 EXPANSION") + harvest-metadata columns on group_posts
// (discovery_question_id, last_harvested_at, harvest_count) + question-id
// backfill for the campaign rows already live.
//
// Safe to re-run — IF NOT EXISTS / DROP-then-CREATE policy throughout; the
// backfills are scoped to category='tc_discovery_research' rows whose
// discovery_question_id IS NULL and touch nothing else.
//
// DDL isn't reachable through PostgREST, so this runs directly against
// Postgres via api/_lib/pg-admin.js (POSTGRES_URL_NON_POOLING). Mirrors
// supabase/migrations/20260907_tc_discovery_responses.sql and the exact
// pattern of api/admin-migrate-comment-watchlist.js.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-07

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
CREATE TABLE IF NOT EXISTS public.tc_discovery_responses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_post_id     UUID REFERENCES public.group_posts(id) ON DELETE SET NULL,
  post_url          TEXT NOT NULL,
  question_id       TEXT CHECK (question_id ~ '^Q[0-9]{1,2}$'),
  platform          TEXT NOT NULL DEFAULT 'facebook'
                    CHECK (platform IN ('facebook', 'reddit', 'manual')),
  source_group      TEXT,
  commenter_name    TEXT NOT NULL,
  comment_text      TEXT NOT NULL,
  comment_hash      TEXT GENERATED ALWAYS AS (md5(comment_text)) STORED,
  comment_permalink TEXT,
  commented_at      TIMESTAMPTZ,
  commented_at_raw  TEXT,
  is_own_comment    BOOLEAN NOT NULL DEFAULT FALSE,
  harvested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  theme             TEXT,
  pain_category     TEXT,
  sentiment         TEXT CHECK (sentiment IN ('positive', 'negative', 'neutral', 'mixed')),
  tags              TEXT[],
  replied           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.tc_discovery_responses
  DROP CONSTRAINT IF EXISTS tc_discovery_responses_dedupe;
ALTER TABLE public.tc_discovery_responses
  ADD CONSTRAINT tc_discovery_responses_dedupe
  UNIQUE (post_url, commenter_name, comment_hash);

CREATE INDEX IF NOT EXISTS idx_tc_discovery_responses_post
  ON public.tc_discovery_responses (group_post_id);

CREATE INDEX IF NOT EXISTS idx_tc_discovery_responses_question
  ON public.tc_discovery_responses (question_id);

COMMENT ON TABLE public.tc_discovery_responses IS
  'TC discovery campaign responses (docs/TC-DISCOVERY-CAMPAIGN.md). comment_text is VERBATIM agent language for landing copy — never normalize, summarize, truncate, or clean it. Classification columns stay NULL until review.';
COMMENT ON COLUMN public.tc_discovery_responses.comment_text IS
  'VERBATIM comment text as rendered on the platform. The entire point of the table. Never edited.';
COMMENT ON COLUMN public.tc_discovery_responses.comment_hash IS
  'Generated md5(comment_text); part of the dedupe key so re-harvests never duplicate rows.';
COMMENT ON COLUMN public.tc_discovery_responses.commented_at_raw IS
  'The platform''s rendered timestamp exactly as scraped ("2h", "Yesterday at 3:14 PM") — kept because the parsed commented_at is best-effort.';

ALTER TABLE public.tc_discovery_responses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tc_discovery_responses_service_all ON public.tc_discovery_responses;
CREATE POLICY tc_discovery_responses_service_all ON public.tc_discovery_responses
  FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.group_posts
  ADD COLUMN IF NOT EXISTS discovery_question_id TEXT
    CHECK (discovery_question_id ~ '^Q[0-9]{1,2}$' OR discovery_question_id IS NULL),
  ADD COLUMN IF NOT EXISTS last_harvested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS harvest_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.group_posts.discovery_question_id IS
  'TC discovery campaign question (Q1-Q13, docs/TC-DISCOVERY-CAMPAIGN.md). Set at queue time for campaign rows (category=tc_discovery_research).';
COMMENT ON COLUMN public.group_posts.last_harvested_at IS
  'Last time scripts/harvest-tc-discovery-responses.js read this post''s comments.';
COMMENT ON COLUMN public.group_posts.harvest_count IS
  'Completed harvest passes; drives the +24h / +72h / every-3-days cadence in the harvester.';

UPDATE public.group_posts SET discovery_question_id = 'Q1'
  WHERE category = 'tc_discovery_research' AND discovery_question_id IS NULL
    AND post_body LIKE '%when you have hired a TC or thought about it%';
UPDATE public.group_posts SET discovery_question_id = 'Q2'
  WHERE category = 'tc_discovery_research' AND discovery_question_id IS NULL
    AND post_body LIKE '%drove you the most crazy%';
UPDATE public.group_posts SET discovery_question_id = 'Q3'
  WHERE category = 'tc_discovery_research' AND discovery_question_id IS NULL
    AND post_body LIKE '%make your TC do ONE thing%';
UPDATE public.group_posts SET discovery_question_id = 'Q4'
  WHERE category = 'tc_discovery_research' AND discovery_question_id IS NULL
    AND post_body LIKE '%what TC software or platform%';
UPDATE public.group_posts SET discovery_question_id = 'Q6'
  WHERE category = 'tc_discovery_research' AND discovery_question_id IS NULL
    AND post_body LIKE '%what do y''all actually pay%';
UPDATE public.group_posts SET discovery_question_id = 'Q8'
  WHERE category = 'tc_discovery_research' AND discovery_question_id IS NULL
    AND post_body LIKE '%fired a TC or switched to a new one%';
`;

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(SQL);
    return res.status(200).json({
      ok: true,
      message: 'tc_discovery_responses table + group_posts harvest metadata created successfully',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to create tc_discovery_responses',
      detail: err.message,
    });
  }
};
