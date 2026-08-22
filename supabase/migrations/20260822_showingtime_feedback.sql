-- ShowingTime feedback ingestion — capability #3 of the "Email Integration"
-- add-on. Watches a connected inbox for ShowingTime's feedback-notification
-- emails, parses agent/buyer feedback per showing, and files it against the
-- relevant listing. Feeds the (separately spec'd) weekly listing-performance
-- digest.
--
-- Same architectural pattern as public.esign_events (20260814): one row per
-- source email, deduped by (user_id, source_message_id), matched to a
-- transaction on a best-effort basis (address match in the notification body).

CREATE TABLE IF NOT EXISTS public.showingtime_feedback (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_id     UUID REFERENCES public.transactions(id) ON DELETE SET NULL,
  property_address   TEXT,
  showing_agent_name TEXT,
  showing_agent_email TEXT,
  showing_date       TIMESTAMPTZ,
  rating             TEXT, -- ShowingTime's own scale text, e.g. "Excellent" -- not normalized, kept as reported
  feedback_text       TEXT,
  source_message_id  TEXT NOT NULL,
  source_thread_id   TEXT,
  subject            TEXT,
  filed              BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.showingtime_feedback IS
  'Parsed ShowingTime feedback-notification emails, one row per email. Feeds the weekly listing-performance digest and files a note into the matched transaction (if any).';

CREATE UNIQUE INDEX IF NOT EXISTS idx_showingtime_feedback_source_msg
  ON public.showingtime_feedback (user_id, source_message_id);

CREATE INDEX IF NOT EXISTS idx_showingtime_feedback_transaction
  ON public.showingtime_feedback (transaction_id, showing_date DESC)
  WHERE transaction_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.showingtime_feedback_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_showingtime_feedback_touch_updated_at ON public.showingtime_feedback;
CREATE TRIGGER trg_showingtime_feedback_touch_updated_at
  BEFORE UPDATE ON public.showingtime_feedback
  FOR EACH ROW EXECUTE FUNCTION public.showingtime_feedback_touch_updated_at();

ALTER TABLE public.showingtime_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own showingtime_feedback" ON public.showingtime_feedback;
CREATE POLICY "Users can view their own showingtime_feedback"
  ON public.showingtime_feedback FOR SELECT
  USING ((select auth.uid()) = user_id);
