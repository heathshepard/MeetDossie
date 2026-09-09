-- 20260909_group_post5_daily.sql
--
-- Daily 5-group-post pipeline. Heath's decision 2026-09-09, verbatim:
-- "people can post more than once a day. 5 groups 1 post to each group per
-- day is fine" -- one originated post per day into EACH of the 5 groups in
-- scripts/comment-hunt-groups.json (dfw_network_collab, tc_admins, tc_vas,
-- kw_re_group, tx_re_agents), 20 min apart (jittered 18-24), never repeating
-- a body or near-duplicate hook in the same group within 30 days.
--
-- Reuses the existing public.group_posts table (shared with the older
-- 32-group group_registry rotation campaign -- see api/_lib/group-post-
-- generator.js) but marks its own rows with pipeline='daily5' so the two
-- systems never cross-select each other's rows. The older campaign's
-- self-promotional first_comment_body pattern does NOT apply here -- this
-- pipeline is value-only / Heath's-own-voice content, gated per group by
-- scripts/_lib/group-post-content-gate.js.
--
-- Owner: Carter, 2026-09-09

ALTER TABLE public.group_posts
  ADD COLUMN IF NOT EXISTS pipeline TEXT DEFAULT NULL;

ALTER TABLE public.group_posts
  ADD COLUMN IF NOT EXISTS group_key TEXT DEFAULT NULL;

-- Which of the 5 GROUP-ENGAGEMENT-PLAN.md formats generated this post
-- (ask_advice / founder_story / contrarian / teardown / resource_giveaway).
-- Used for the "near-duplicate hook" dedupe layer -- same hook_type in the
-- same group inside 30 days is treated as a near-duplicate even if the
-- wording differs.
ALTER TABLE public.group_posts
  ADD COLUMN IF NOT EXISTS hook_type TEXT DEFAULT NULL;

-- Exact-content dedupe, same spirit as comment_opportunities.post_hash --
-- normalized (whitespace-collapsed, trimmed) md5 of post_body.
ALTER TABLE public.group_posts
  ADD COLUMN IF NOT EXISTS content_hash TEXT
  GENERATED ALWAYS AS (md5(btrim(regexp_replace(post_body, '\s+', ' ', 'g')))) STORED;

CREATE INDEX IF NOT EXISTS idx_group_posts_daily5_group_recent
  ON public.group_posts (group_key, created_at)
  WHERE pipeline = 'daily5';

CREATE INDEX IF NOT EXISTS idx_group_posts_daily5_status
  ON public.group_posts (pipeline, status)
  WHERE pipeline = 'daily5';

COMMENT ON COLUMN public.group_posts.pipeline IS
  'NULL = legacy group_registry rotation campaign. ''daily5'' = the 5-group daily pipeline (api/_lib/daily-group5-post-generator.js). Keeps the two group_posts producers/consumers from ever selecting each other''s rows.';
COMMENT ON COLUMN public.group_posts.group_key IS
  'Matches the "key" field in scripts/comment-hunt-groups.json for daily5 rows (e.g. dfw_network_collab). NULL for legacy rows, which key off group_registry_id instead.';
COMMENT ON COLUMN public.group_posts.hook_type IS
  'daily5 only: which content format generated this post (ask_advice/founder_story/contrarian/teardown/resource_giveaway). Used for near-duplicate-hook dedupe.';
COMMENT ON COLUMN public.group_posts.content_hash IS
  'Generated column: md5 of whitespace-normalized post_body. Exact-duplicate dedupe layer for the daily5 pipeline.';
