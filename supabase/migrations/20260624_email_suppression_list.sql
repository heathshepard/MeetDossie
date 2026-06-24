-- supabase/migrations/20260624_email_suppression_list.sql
-- Creates email_suppression_list table for CAN-SPAM compliance.
-- Records unsubscribe requests from cold-email campaigns + other sources.

CREATE TABLE IF NOT EXISTS email_suppression_list (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'cold_email',
  reason TEXT,
  unsubscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index on email for quick lookups during send-time checks
CREATE INDEX IF NOT EXISTS idx_email_suppression_email ON email_suppression_list(email);

-- Index on source for filtering by campaign type
CREATE INDEX IF NOT EXISTS idx_email_suppression_source ON email_suppression_list(source);

-- RLS: Allow public INSERT (so the /api/unsubscribe endpoint works even with anon key).
-- Service role bypasses RLS automatically for SELECT/UPDATE/DELETE (used by admin tooling).
-- No SELECT/UPDATE/DELETE policies for anon = deny by default.
-- NOTE: profiles.is_admin does not exist in this database; admin-gated policies
-- were removed in favor of service-role-only access for non-INSERT operations.
ALTER TABLE email_suppression_list ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public insert" ON email_suppression_list;
CREATE POLICY "Allow public insert" ON email_suppression_list
  FOR INSERT
  WITH CHECK (true);
