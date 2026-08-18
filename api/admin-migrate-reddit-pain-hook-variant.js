// One-time migration: reddit_pain_language table + social_posts.hook_variant.
// Mirrors supabase/migrations/20260818c_reddit_pain_and_hook_variant.sql and
// the exact pattern of api/admin-migrate-image-mismatch-hold-status.js.
//
// DDL isn't reachable through PostgREST, so this runs directly against
// Postgres via api/_lib/pg-admin.js (POSTGRES_URL_NON_POOLING).
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Sage, 2026-08-18

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
CREATE TABLE IF NOT EXISTS public.reddit_pain_language (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reddit_id TEXT NOT NULL UNIQUE,
  subreddit TEXT NOT NULL,
  title TEXT NOT NULL,
  snippet TEXT,
  url TEXT,
  pain_categories TEXT[] NOT NULL DEFAULT '{}',
  match_count INT NOT NULL DEFAULT 0,
  posted_at TIMESTAMPTZ,
  rank_score NUMERIC NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reddit_pain_language_rank
  ON public.reddit_pain_language (rank_score DESC);
CREATE INDEX IF NOT EXISTS idx_reddit_pain_language_categories
  ON public.reddit_pain_language USING GIN (pain_categories);
CREATE INDEX IF NOT EXISTS idx_reddit_pain_language_posted_at
  ON public.reddit_pain_language (posted_at DESC NULLS LAST);

ALTER TABLE public.reddit_pain_language ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role full access" ON public.reddit_pain_language;
CREATE POLICY "service role full access"
  ON public.reddit_pain_language FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE public.social_posts
ADD COLUMN IF NOT EXISTS hook_variant TEXT;

CREATE INDEX IF NOT EXISTS idx_social_posts_hook_variant
  ON public.social_posts (hook_variant) WHERE hook_variant IS NOT NULL;
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
      message: 'reddit_pain_language created, social_posts.hook_variant added',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to apply reddit_pain_language / hook_variant migration',
      details: err.message,
    });
  }
};
