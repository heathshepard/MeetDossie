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

-- RLS: Allow anyone to INSERT (public unsubscribe endpoint)
-- but restrict SELECT/UPDATE/DELETE to authenticated admin
ALTER TABLE email_suppression_list ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public insert" ON email_suppression_list
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Allow admin select" ON email_suppression_list
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.is_admin = true
    )
  );

CREATE POLICY "Allow admin update" ON email_suppression_list
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.is_admin = true
    )
  );

CREATE POLICY "Allow admin delete" ON email_suppression_list
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.is_admin = true
    )
  );
