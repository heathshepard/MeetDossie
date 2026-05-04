-- Phase 1 marketing pipeline — schema additions to social_posts.
-- Run once in Supabase Studio → SQL Editor.
--
-- All columns are nullable so existing rows keep working. The
-- generator/sender/webhook code populates them on new rows.

ALTER TABLE social_posts
  ADD COLUMN IF NOT EXISTS persona             TEXT,
  ADD COLUMN IF NOT EXISTS topic               TEXT,
  ADD COLUMN IF NOT EXISTS telegram_sent_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT,
  ADD COLUMN IF NOT EXISTS approved_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS generated_at        TIMESTAMPTZ;

-- The original status_check constraint omitted 'rejected', which silently
-- failed every Reject button tap from the Telegram approval webhook.
-- Re-create the constraint with the full set the code actually writes.
ALTER TABLE social_posts DROP CONSTRAINT IF EXISTS social_posts_status_check;
ALTER TABLE social_posts ADD CONSTRAINT social_posts_status_check
  CHECK (status IN ('draft','approved','rejected','scheduled','posted','failed'));

-- Helpful indexes for the cron queries.
CREATE INDEX IF NOT EXISTS social_posts_status_telegram_sent_idx
  ON social_posts (status, telegram_sent_at)
  WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS social_posts_status_posted_idx
  ON social_posts (status, posted_at)
  WHERE status = 'approved';

-- Sanity check — should list all six new columns.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'social_posts'
  AND column_name IN ('persona','topic','telegram_sent_at','telegram_message_id','approved_at','generated_at')
ORDER BY column_name;
