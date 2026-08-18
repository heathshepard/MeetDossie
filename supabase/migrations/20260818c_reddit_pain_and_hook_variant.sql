-- Reddit pain-language mining + N-way hook-variant testing
-- Author: Sage, 2026-08-18
-- Purpose:
--   1. reddit_pain_language — real complaint/pain-point language scraped from
--      r/realtors, r/RealEstateAgents, r/RealEstateAdvice, used as content
--      fuel for cron-generate-posts.js (same "real language, not guessed"
--      pattern as the Ad Library scraper's content-fuel block).
--   2. social_posts.hook_variant — a human-readable variant label (e.g.
--      "urgency_open", "cost_focus", "original") distinct from the existing
--      `variant` column (which only ever holds the A/B letter). Lets a single
--      test group span more than 2 variants (Schneider tactic: 10-20 opening
--      lines on the same value prop, real engagement picks the winner).
--   3. post_analytics gets the same hook_variant copied over at sync time so
--      the already-built weekly review (cron-weekly-post-review.js /
--      sage_weekly_review.js) can actually bucket by it — today that column
--      exists (added 20260708) but nothing ever writes to it.

-- ═══ 1. Reddit pain-language table ═════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.reddit_pain_language (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reddit_id TEXT NOT NULL UNIQUE, -- short Reddit post id (e.g. "1u0msl7")
  subreddit TEXT NOT NULL,
  title TEXT NOT NULL,
  snippet TEXT, -- stripped body excerpt, real language, not paraphrased
  url TEXT,
  pain_categories TEXT[] NOT NULL DEFAULT '{}', -- e.g. {tc_pain, deadline_stress, paperwork_overwhelm}
  match_count INT NOT NULL DEFAULT 0, -- how many pain-keyword hits in title+body
  posted_at TIMESTAMPTZ, -- Reddit's <published> timestamp
  rank_score NUMERIC NOT NULL DEFAULT 0, -- match_count weighted by recency, computed at scrape time
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

-- ═══ 2. hook_variant on social_posts ════════════════════════════════════════

ALTER TABLE public.social_posts
ADD COLUMN IF NOT EXISTS hook_variant TEXT;

CREATE INDEX IF NOT EXISTS idx_social_posts_hook_variant
  ON public.social_posts (hook_variant) WHERE hook_variant IS NOT NULL;
