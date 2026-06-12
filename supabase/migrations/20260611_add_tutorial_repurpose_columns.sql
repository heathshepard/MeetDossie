-- Add columns to track tutorial video repurposing
ALTER TABLE public.social_posts
ADD COLUMN tutorial_video_id uuid REFERENCES public.tutorial_videos(id) ON DELETE SET NULL,
ADD COLUMN source_type text;

-- Index for querying repurposed posts
CREATE INDEX idx_social_posts_tutorial_video_id ON public.social_posts(tutorial_video_id);
CREATE INDEX idx_social_posts_source_type ON public.social_posts(source_type);
