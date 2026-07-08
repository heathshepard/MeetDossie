-- Post Analytics Content Enrichment
-- Author: Carter
-- Date: 2026-07-08
-- Purpose: Add hook_type, cta_type, hook_variant, sound_title, topic, hook, persona
--          to post_analytics for Sage A/B performance ranking

ALTER TABLE public.post_analytics
ADD COLUMN IF NOT EXISTS hook_type TEXT,
ADD COLUMN IF NOT EXISTS cta_type TEXT,
ADD COLUMN IF NOT EXISTS hook_variant TEXT,
ADD COLUMN IF NOT EXISTS sound_title TEXT,
ADD COLUMN IF NOT EXISTS topic TEXT,
ADD COLUMN IF NOT EXISTS hook TEXT,
ADD COLUMN IF NOT EXISTS persona TEXT;

-- Index for Sage queries (hook_type + engagement ranking)
CREATE INDEX IF NOT EXISTS idx_post_analytics_hook_type_engagement
  ON public.post_analytics (hook_type, fetched_at DESC);

-- Index for CTA performance analysis
CREATE INDEX IF NOT EXISTS idx_post_analytics_cta_type_engagement
  ON public.post_analytics (cta_type, fetched_at DESC);

-- Index for persona performance
CREATE INDEX IF NOT EXISTS idx_post_analytics_persona_engagement
  ON public.post_analytics (persona, fetched_at DESC);
