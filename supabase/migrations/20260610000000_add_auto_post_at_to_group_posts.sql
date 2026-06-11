-- Add auto_post_at column to track posts queued for autonomous posting
ALTER TABLE public.group_posts ADD COLUMN auto_post_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

-- Create index for polling efficiency
CREATE INDEX idx_group_posts_auto_post_pending ON public.group_posts(auto_post_at) WHERE auto_post_at IS NOT NULL AND posted_at IS NULL;
