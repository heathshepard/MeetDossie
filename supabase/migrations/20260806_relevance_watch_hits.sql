-- 2026-08-06 — relevance_watch_hits table for /api/cron-relevance-watcher.
--
-- Companion to email_watcher_state/email_watcher_senders (SV-EMAIL-001), but a
-- different mechanism: instead of narrow sender-pattern matching, this cron
-- scans Heath's KW inbox (heath.shepard@kw.com) broadly, strips obvious bulk/
-- marketing mail, and runs a cheap Haiku classification against his live
-- active deals (transactions table), known clients, and the Dossie/MeetDossie
-- business itself. Anything classified relevant lands here for a human/Cole
-- session to triage later — this table is a landing zone, not a notifier.
--
-- v1 is dry-run only: no Telegram send happens from this cron yet (see
-- RELEVANCE_WATCHER_NOTIFY feature flag in api/cron-relevance-watcher.js,
-- which stays unset/off until Heath approves a live channel + frequency).
--
-- Also seeds the 'relevance' tier row in email_watcher_state, following the
-- exact checkpoint pattern tier1/tier2 already use (one row per tier, PK on
-- `tier`). Unlike tier1/tier2 — which are read/written by an Anthropic-cloud
-- routine through the public /api/email-watcher-state proxy because that
-- routine cannot hold SUPABASE_SERVICE_ROLE_KEY — this cron is itself a
-- Vercel serverless function that already holds the service-role key, so it
-- reads/writes its checkpoint directly rather than through that proxy.

CREATE TABLE IF NOT EXISTS public.relevance_watch_hits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_message_id text NOT NULL UNIQUE,
  gmail_thread_id text,
  from_email text,
  from_name text,
  subject text,
  snippet text,
  matched_deal_or_person text,             -- e.g. "104 Wild Cherry Ln" or "Kanika Jain" or "Dossie/MeetDossie"
  reason text,                             -- <=2 sentence Haiku explanation
  notified boolean NOT NULL DEFAULT false, -- flips true once/if a live notify step ships
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS relevance_watch_hits_created_at_idx
  ON public.relevance_watch_hits(created_at DESC);

CREATE INDEX IF NOT EXISTS relevance_watch_hits_notified_idx
  ON public.relevance_watch_hits(notified) WHERE notified = false;

COMMENT ON TABLE public.relevance_watch_hits IS
  'Landing zone for /api/cron-relevance-watcher — Haiku-classified KW-inbox hits relevant to active deals/clients/Dossie business. Dry-run only as of 2026-08-06: nothing here has been notified anywhere yet.';

-- Service-role only. No client-facing reads; Heath/Cole review this via
-- Supabase directly or a future admin surface, not the customer app.
ALTER TABLE public.relevance_watch_hits ENABLE ROW LEVEL SECURITY;

-- Seed the checkpoint row this cron reads/writes each run. Starts 15 minutes
-- back so the very first run has a real (small) window instead of scanning
-- everything since epoch.
INSERT INTO public.email_watcher_state (tier, last_check_ts)
VALUES ('relevance', now() - interval '15 minutes')
ON CONFLICT (tier) DO NOTHING;
