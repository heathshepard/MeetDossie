-- Companion to 20260817_zernio_accounts_owner.sql. `social_posts.platform`
-- alone is ambiguous between Dossie's Facebook Page and Heath's realtor
-- Facebook Page once both zernio_accounts rows exist. Adds target_owner so a
-- post can be explicitly routed to the right destination.
--
-- Defaults every existing/future row to 'dossie' — the entire current
-- content pipeline (cron-generate-posts.js, cron-coverage-check.js,
-- cron-publish-approved.js) never sets this column, so nothing changes
-- until something explicitly writes target_owner='heath-realtor'.

ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS target_owner text NOT NULL DEFAULT 'dossie';

ALTER TABLE public.social_posts
  DROP CONSTRAINT IF EXISTS social_posts_target_owner_check;

ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_target_owner_check
  CHECK (target_owner IN ('dossie', 'heath-realtor'));

CREATE INDEX IF NOT EXISTS idx_social_posts_target_owner
  ON public.social_posts (target_owner)
  WHERE target_owner <> 'dossie';

COMMENT ON COLUMN public.social_posts.target_owner IS
  'Which zernio_accounts.owner this post publishes through: dossie (default, product Pages) or heath-realtor (Heath''s personal facebook.com/HeathShepardRealtor Page). Read by cron-publish-approved.js pushToZernio() to pick the right zernio_account_id when platform alone is ambiguous.';
