-- Sage day-of-mission checkpoint query
-- Run via Supabase MCP execute_sql to get one-shot mission state.

WITH today AS (
  SELECT (now() AT TIME ZONE 'America/Chicago')::date AS d
)
SELECT
  'posts_shipped_today' AS metric,
  json_build_object(
    'twitter', (SELECT count(*) FROM social_posts, today WHERE platform='twitter' AND status='posted' AND posted_at >= today.d),
    'linkedin', (SELECT count(*) FROM social_posts, today WHERE platform='linkedin' AND status='posted' AND posted_at >= today.d),
    'instagram', (SELECT count(*) FROM social_posts, today WHERE platform='instagram' AND status='posted' AND posted_at >= today.d),
    'facebook', (SELECT count(*) FROM social_posts, today WHERE platform='facebook' AND status='posted' AND posted_at >= today.d),
    'tiktok', (SELECT count(*) FROM social_posts, today WHERE platform='tiktok' AND status='posted' AND posted_at >= today.d),
    'youtube', (SELECT count(*) FROM social_posts, today WHERE platform='youtube' AND status='posted' AND posted_at >= today.d)
  ) AS state

UNION ALL SELECT
  'posts_pending_today_approved',
  json_build_object(
    'twitter', (SELECT count(*) FROM social_posts WHERE platform='twitter' AND status='approved'),
    'linkedin', (SELECT count(*) FROM social_posts WHERE platform='linkedin' AND status='approved'),
    'instagram', (SELECT count(*) FROM social_posts WHERE platform='instagram' AND status='approved'),
    'facebook', (SELECT count(*) FROM social_posts WHERE platform='facebook' AND status='approved'),
    'tiktok', (SELECT count(*) FROM social_posts WHERE platform='tiktok' AND status='approved')
  )

UNION ALL SELECT
  'engagement_candidates_today',
  json_build_object(
    'pending', (SELECT count(*) FROM engagement_candidates, today WHERE created_at >= today.d AND status='pending'),
    'approved', (SELECT count(*) FROM engagement_candidates, today WHERE created_at >= today.d AND status='approved'),
    'posted', (SELECT count(*) FROM engagement_candidates, today WHERE created_at >= today.d AND status='posted'),
    'rejected', (SELECT count(*) FROM engagement_candidates, today WHERE created_at >= today.d AND status='rejected'),
    'sent_for_approval', (SELECT count(*) FROM engagement_candidates, today WHERE created_at >= today.d AND status='sent_for_approval')
  )

UNION ALL SELECT
  'group_posts_today',
  json_build_object(
    'draft', (SELECT count(*) FROM group_posts, today WHERE created_at >= today.d AND status='draft'),
    'approved', (SELECT count(*) FROM group_posts, today WHERE created_at >= today.d AND status='approved'),
    'posted', (SELECT count(*) FROM group_posts, today WHERE created_at >= today.d AND status='posted'),
    'rejected', (SELECT count(*) FROM group_posts, today WHERE created_at >= today.d AND status='rejected'),
    'failed', (SELECT count(*) FROM group_posts, today WHERE created_at >= today.d AND status='failed')
  )

UNION ALL SELECT
  'reddit_engagements_today',
  json_build_object(
    'posted', (SELECT count(*) FROM reddit_engagements, today WHERE created_at >= today.d AND status='posted'),
    'pending', (SELECT count(*) FROM reddit_engagements, today WHERE created_at >= today.d AND status='pending'),
    'deleted', (SELECT count(*) FROM reddit_engagements, today WHERE created_at >= today.d AND status='deleted')
  )

UNION ALL SELECT
  'tutorial_videos_today',
  json_build_object(
    'total', (SELECT count(*) FROM tutorial_videos),
    'published', (SELECT count(*) FROM tutorial_videos WHERE status='published'),
    'new_today', (SELECT count(*) FROM tutorial_videos, today WHERE created_at >= today.d)
  )
;
