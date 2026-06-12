-- Migration: Create activation_events table for funnel tracking
-- Date: 2026-06-12
-- Purpose: Track user activation milestones (dossier creation, doc upload, etc.)

CREATE TABLE activation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'signup_completed',
    'profile_completed',
    'first_login',
    'first_dossier_created',
    'first_document_uploaded',
    'first_email_queued',
    'first_action_item_completed',
    'first_amendment_drafted',
    'first_form_attached',
    'first_milestone_created',
    'first_morning_brief_listened',
    'first_voice_command'
  )),
  metadata JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_activation_events_user_created ON activation_events(user_id, created_at);
CREATE INDEX idx_activation_events_type_created ON activation_events(event_type, created_at);
CREATE UNIQUE INDEX idx_activation_events_user_type ON activation_events(user_id, event_type);

-- Enable RLS for activation_events
ALTER TABLE activation_events ENABLE ROW LEVEL SECURITY;

-- Users can see their own activation events
CREATE POLICY "Users can read own activation events"
  ON activation_events FOR SELECT
  USING (auth.uid() = user_id);

-- Service role can insert/update for lifecycle tracking
CREATE POLICY "Service role manages activation events"
  ON activation_events FOR ALL
  USING (true) WITH CHECK (true);

-- Help feedback table for knowledge base articles
CREATE TABLE help_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  article_slug TEXT NOT NULL,
  helpful BOOLEAN NOT NULL,
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_help_feedback_article ON help_feedback(article_slug, created_at);
CREATE INDEX idx_help_feedback_user ON help_feedback(user_id, created_at);

ALTER TABLE help_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own feedback"
  ON help_feedback FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert feedback"
  ON help_feedback FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- What's New announcements
CREATE TABLE whats_new_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  cta_label TEXT,
  cta_url TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_whats_new_active ON whats_new_announcements(active, created_at DESC);

-- Dismissals are stored per-user
CREATE TABLE whats_new_dismissals (
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  announcement_id UUID REFERENCES whats_new_announcements(id) ON DELETE CASCADE NOT NULL,
  dismissed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, announcement_id)
);

CREATE INDEX idx_whats_new_dismissals_user ON whats_new_dismissals(user_id);

ALTER TABLE whats_new_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE whats_new_dismissals ENABLE ROW LEVEL SECURITY;

-- Anyone can read active announcements
CREATE POLICY "Anyone can read active announcements"
  ON whats_new_announcements FOR SELECT
  USING (active = true);

-- Users can manage their own dismissals
CREATE POLICY "Users can read own dismissals"
  ON whats_new_dismissals FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert dismissals"
  ON whats_new_dismissals FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Activation triage audit log
CREATE TABLE activation_triage_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  action TEXT NOT NULL,
  days_since_signup INTEGER,
  metadata JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_activation_triage_log_user ON activation_triage_log(user_id, created_at);
CREATE INDEX idx_activation_triage_log_action ON activation_triage_log(action, created_at);

ALTER TABLE activation_triage_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages triage log"
  ON activation_triage_log FOR ALL
  USING (true) WITH CHECK (true);
