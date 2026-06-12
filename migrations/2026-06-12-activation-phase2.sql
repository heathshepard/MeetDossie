-- Activation Education Phase 2 — June 12, 2026
-- Adds welcome-drip column tracking, What's New announcements seed data, and help_feedback table

-- 1. Add welcome-drip tracking columns to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS welcome_day1_sent_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS welcome_day3_sent_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS welcome_day7_sent_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS welcome_day14_sent_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS welcome_day30_sent_at TIMESTAMPTZ DEFAULT NULL;

-- 2. Seed What's New announcements (5 ready entries)
-- Ensure table exists first
CREATE TABLE IF NOT EXISTS whats_new_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  cta_label TEXT,
  cta_url TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert the 5 ready-to-ship announcements (if they don't exist already)
INSERT INTO whats_new_announcements (slug, title, body, cta_label, cta_url, active, created_at)
VALUES
  ('dossiesign-live', 'DossieSign is live', 'Fill TREC forms in two clicks.', 'Learn more', '/help/dossiesign', TRUE, NOW()),
  ('voice-commands-live', 'Voice contracts via Talk to Dossie', 'Tap the mic and say what you need.', 'Learn how', '/help/talk-to-dossie', TRUE, NOW()),
  ('form-packages-live', 'Form Packages', 'Apply a whole TREC bundle in one tap.', 'See how', '/help/dossiesign', TRUE, NOW()),
  ('desktop-doc-buttons', 'New: cleaner document buttons on desktop', 'Easier to scan and click.', 'Got it', NULL, TRUE, NOW()),
  ('form-library-live', 'New: browse and attach any TREC form from the Form Library', 'Browse every form your dossiers need.', 'Explore', '/help/dossiesign', TRUE, NOW())
ON CONFLICT (slug) DO NOTHING;

-- 3. Help feedback table (for "Was this helpful?" on /help pages)
CREATE TABLE IF NOT EXISTS help_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_slug TEXT NOT NULL,
  helpful BOOLEAN NOT NULL,
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for user queries
CREATE INDEX IF NOT EXISTS idx_help_feedback_user_id ON help_feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_help_feedback_page_slug ON help_feedback(page_slug);
