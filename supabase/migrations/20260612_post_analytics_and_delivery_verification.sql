-- Phase 1: Delivery Verification + Phase 2: Analytics Tables
-- Author: Carter
-- Date: 2026-06-12
-- Purpose: Add zernio_verified_at + actual_platform_url to social_posts,
--          create post_analytics and account_analytics tables for engagement tracking

-- ═══ PHASE 1: Delivery Verification ═══════════════════════════════════════
-- Add columns to social_posts to track Zernio delivery verification

ALTER TABLE public.social_posts
ADD COLUMN IF NOT EXISTS zernio_verified_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS actual_platform_url TEXT;

CREATE INDEX IF NOT EXISTS idx_social_posts_zernio_verified_at
  ON public.social_posts (zernio_verified_at DESC NULLS LAST);

-- ═══ PHASE 2: Analytics Tables ═════════════════════════════════════════

-- post_analytics — per-post engagement metrics
-- One row per post per day to build a time-series
CREATE TABLE IF NOT EXISTS public.post_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  social_post_id UUID REFERENCES public.social_posts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  impressions INT,
  reach INT,
  likes INT,
  comments INT,
  shares INT,
  saves INT,
  profile_clicks INT,
  link_clicks INT,
  engagement_rate NUMERIC,
  raw_response JSONB,
  CONSTRAINT unique_post_per_day UNIQUE (social_post_id, DATE(fetched_at))
);

CREATE INDEX IF NOT EXISTS idx_post_analytics_platform
  ON public.post_analytics (platform);
CREATE INDEX IF NOT EXISTS idx_post_analytics_fetched_at
  ON public.post_analytics (fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_analytics_social_post_id
  ON public.post_analytics (social_post_id);

ALTER TABLE public.post_analytics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role full access" ON public.post_analytics;
CREATE POLICY "service role full access"
  ON public.post_analytics FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- account_analytics — per-platform follower counts and account-level metrics
-- One row per platform per day for tracking growth over time
CREATE TABLE IF NOT EXISTS public.account_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL UNIQUE(platform, DATE(fetched_at)),
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  followers INT,
  following INT,
  total_posts INT,
  profile_views INT,
  biography_clicks INT,
  raw_response JSONB
);

CREATE INDEX IF NOT EXISTS idx_account_analytics_platform
  ON public.account_analytics (platform);
CREATE INDEX IF NOT EXISTS idx_account_analytics_fetched_at
  ON public.account_analytics (fetched_at DESC);

ALTER TABLE public.account_analytics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role full access" ON public.account_analytics;
CREATE POLICY "service role full access"
  ON public.account_analytics FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ═══ PHASE 3: Sage Intelligence Prep ═══════════════════════════════════════
-- Create sage_intelligence table if it doesn't exist to track daily content recommendations
CREATE TABLE IF NOT EXISTS public.sage_intelligence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  analysis_date DATE NOT NULL,
  top_platform TEXT,
  top_pillar TEXT,
  top_persona TEXT,
  winning_patterns JSONB,
  losing_patterns JSONB,
  raw_analytics JSONB
);

CREATE INDEX IF NOT EXISTS idx_sage_intelligence_date
  ON public.sage_intelligence (analysis_date DESC);

ALTER TABLE public.sage_intelligence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role full access" ON public.sage_intelligence;
CREATE POLICY "service role full access"
  ON public.sage_intelligence FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
