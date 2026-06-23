-- Add review_feedback column to social_posts for Cole's autonomous review feedback
-- Author: Carter
-- Date: 2026-06-20
-- Purpose: Capture Cole's feedback when a post needs regeneration via cron-sage-autonomous-review

ALTER TABLE public.social_posts
ADD COLUMN IF NOT EXISTS review_feedback TEXT;

CREATE INDEX IF NOT EXISTS idx_social_posts_review_feedback
  ON public.social_posts (review_feedback)
  WHERE review_feedback IS NOT NULL;

-- Ensure proper RLS is in place (service role can write this)
-- The existing RLS on social_posts should handle this automatically
