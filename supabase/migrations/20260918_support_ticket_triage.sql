-- 20260918_support_ticket_triage.sql
--
-- THE CASE THIS EXISTS TO PREVENT
--   2026-08-24, support_tickets row 503a1d1b: Amanda Nuckles, a paying
--   founding member, wrote in and asked "How do I cancel my account?".
--   Nobody replied. The row is still status='open' on 2026-09-18. She
--   cancelled.
--
--   Two separate failures, and this migration backs the fix for both:
--     1. Nothing acknowledged her. A customer who writes in heard nothing.
--     2. Nothing classified her. She self-selected ticket_type='bug' in the
--        modal; an auto-responder that trusted that field would have thanked
--        her for a bug report while she was trying to leave — worse than the
--        silence that actually happened.
--
-- WHAT THIS PROVISIONS
--   public.support_triage_log — one row per ticket the triage cron has ever
--   considered, across BOTH products (Dossie's support_tickets and Rust's
--   app_feedback, which lives in a different Supabase project entirely).
--
--   The UNIQUE (source, ticket_id) constraint IS the idempotency guarantee.
--   "One acknowledgement per ticket, ever" is enforced by Postgres, not by a
--   code path that remembers to check. A duplicate apology email is its own
--   bug and this makes it structurally impossible rather than unlikely.
--
-- WHY THE CHECK CONSTRAINTS MATTER
--   2026-09-18 activation forensics found ten profiles flagged as emailed
--   that were never actually emailed — a boolean somebody set optimistically
--   next to code that failed silently. The constraints below make that exact
--   shape illegal here:
--
--     ack_outcome='sent'   REQUIRES a real provider message id AND a sent_at.
--     fix_outcome='queued' REQUIRES a real agent_queue row id.
--
--   So "we acknowledged her" can only ever mean "Resend handed us back an id
--   for a message addressed to her", and "we dispatched a fix" can only ever
--   mean "here is the queue row". Neither can be asserted without evidence.
--
-- Owner: Carter, 2026-09-18

CREATE TABLE IF NOT EXISTS public.support_triage_log (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which product's intake this ticket came from. 'dossie' =
  -- public.support_tickets in THIS project. 'rust' = public.app_feedback in
  -- Supabase project aflqnvlhpkbokfneyhqh (the fitness app's own project,
  -- read via RUST_SUPABASE_URL / RUST_SUPABASE_SERVICE_ROLE_KEY).
  source                  TEXT NOT NULL CHECK (source IN ('dossie', 'rust')),
  ticket_id               UUID NOT NULL,
  ticket_created_at       TIMESTAMPTZ,

  -- Never the message body. The ledger records DECISIONS about a ticket;
  -- the ticket itself stays in its own table, in its own project.
  recipient_email         TEXT,

  -- api/_lib/support-ticket-classify.js output.
  ticket_class            TEXT NOT NULL CHECK (ticket_class IN (
                            'internal', 'cancellation', 'billing', 'unhappy',
                            'legal', 'question', 'feature', 'bug', 'unknown'
                          )),
  route                   TEXT NOT NULL CHECK (route IN (
                            'suppress_internal', 'heath_only', 'ack_only',
                            'ack_and_fix', 'ack_and_escalate'
                          )),
  sensitive_areas         TEXT[] NOT NULL DEFAULT '{}',
  reasons                 JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- ── Acknowledgement leg ────────────────────────────────────────────────
  -- 'claimed' is written FIRST, before any send is attempted, so the unique
  -- constraint reserves the ticket even if the process dies mid-send. A row
  -- stuck at 'claimed' is visible and alarmable; a second ack is not possible.
  ack_outcome             TEXT NOT NULL DEFAULT 'claimed' CHECK (ack_outcome IN (
                            'claimed',              -- reserved, send not yet attempted
                            'sent',                 -- provider accepted it; id recorded
                            'dry_run',              -- composed and validated, deliberately not sent
                            'skipped_disabled',     -- the ops_flags switch is off (default state)
                            'skipped_internal',     -- sender is not a customer
                            'skipped_escalated',    -- cancellation/billing/unhappy/legal — Heath only
                            'skipped_stale',        -- older than the backfill window; never mail history
                            'skipped_capped',       -- hit a rate limit or flood guard
                            'skipped_suppressed',   -- recipient on the suppression list
                            'skipped_no_recipient', -- no address to reply to
                            'skipped_other_system', -- the product's own intake already acks (Rust)
                            'failed'                -- provider rejected it; error recorded
                          )),
  ack_subject             TEXT,
  ack_body                TEXT,
  ack_provider            TEXT,
  ack_provider_message_id TEXT,
  ack_sent_at             TIMESTAMPTZ,
  ack_error               TEXT,
  ack_attempts            INTEGER NOT NULL DEFAULT 0,

  -- ── Fix-dispatch leg ───────────────────────────────────────────────────
  fix_outcome             TEXT NOT NULL DEFAULT 'none' CHECK (fix_outcome IN (
                            'none',                 -- not a bug, or not eligible
                            'queued',               -- agent_queue row created; id recorded
                            'deduped',              -- an equivalent pending row already existed
                            'blocked_sensitive',    -- auth/payments/contracts/data-deletion — Heath decides
                            'escalated',            -- routed to Heath instead of an agent
                            'skipped_capped',
                            'failed'
                          )),
  agent_queue_id          UUID,
  fix_error               TEXT,

  heath_notified_at       TIMESTAMPTZ,
  heath_notify_reason     TEXT,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ONE acknowledgement per ticket, ever. Enforced by the database.
  CONSTRAINT support_triage_log_source_ticket_uniq UNIQUE (source, ticket_id),

  -- "Acknowledged" can never be a flag somebody set optimistically.
  CONSTRAINT support_triage_log_sent_needs_provider_id CHECK (
    ack_outcome <> 'sent'
    OR (ack_provider_message_id IS NOT NULL AND ack_sent_at IS NOT NULL)
  ),

  -- "Dispatched" can never be a flag somebody set optimistically either.
  CONSTRAINT support_triage_log_queued_needs_queue_id CHECK (
    fix_outcome <> 'queued' OR agent_queue_id IS NOT NULL
  )
);

COMMENT ON TABLE public.support_triage_log IS
  'One row per support ticket the triage cron (api/cron-support-ticket-triage.js) has considered, across Dossie (support_tickets) and Rust (app_feedback in project aflqnvlhpkbokfneyhqh). UNIQUE(source,ticket_id) enforces one acknowledgement per ticket forever. CHECK constraints make ack_outcome=sent and fix_outcome=queued unassertable without a real provider message id / queue row id.';
COMMENT ON COLUMN public.support_triage_log.reasons IS
  'JSON array of human-readable strings from support-ticket-classify.js explaining WHY this ticket got this class and route — the audit trail for a wrong call. Includes an explicit note whenever message content overrode the submitter-selected ticket_type (the Amanda case).';
COMMENT ON COLUMN public.support_triage_log.ack_provider_message_id IS
  'The provider''s own id for the acknowledgement (Resend message id). NULL means nothing was sent, regardless of what any other column says.';
COMMENT ON COLUMN public.support_triage_log.sensitive_areas IS
  'Which never-auto-fix tripwires the ticket hit: auth, payments, contracts, data_deletion. Non-empty means the fix was escalated to Heath with the diagnosis however obvious it looked.';

CREATE INDEX IF NOT EXISTS idx_support_triage_log_created
  ON public.support_triage_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_triage_log_recipient_sent
  ON public.support_triage_log (recipient_email, ack_sent_at DESC)
  WHERE ack_sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_support_triage_log_ack_outcome
  ON public.support_triage_log (ack_outcome, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_triage_log_needs_heath
  ON public.support_triage_log (route, created_at DESC)
  WHERE route = 'heath_only';

-- Same RLS pattern as ops_flags / ops_action_log / telegram_send_log: enable,
-- zero policies. Every real caller uses SUPABASE_SERVICE_ROLE_KEY (bypasses
-- RLS); anon/authenticated default to deny-all.
ALTER TABLE public.support_triage_log ENABLE ROW LEVEL SECURITY;

-- ── THE SWITCH ─────────────────────────────────────────────────────────────
--
-- Seeded DISABLED, deliberately. Everything else in this change can ship,
-- run, classify, dispatch fixes, and alarm on its own silence with this flag
-- off — the only thing it gates is a real email reaching a real customer.
--
-- api/_lib/ops-policy.js's checkCapability() fails CLOSED on any read
-- failure, so a missing row, an unreadable table, or a Supabase outage all
-- resolve to "do not send" rather than "send". There is no code path where
-- the absence of a decision becomes permission.
--
-- Heath turns it on with one UPDATE (no deploy required):
--   UPDATE public.ops_flags SET enabled = TRUE, updated_by = 'heath'
--    WHERE key = 'ack_support_ticket';
INSERT INTO public.ops_flags (key, enabled, reason, updated_by) VALUES
  ('ack_support_ticket', FALSE,
   'Auto-acknowledgement of in-app support tickets. OFF until Heath reads the copy and flips it. Scope is deliberately narrow: a receipt over his name to a customer who just wrote in, promising nothing — no timeline, no claim of a fix. Cancellations, billing disputes, unhappy customers and anything legal are routed to Heath and are NEVER eligible for this flag (ops-policy ALWAYS_HEATH: pricing_demo_complaint_conversation).',
   'migration:20260918_support_ticket_triage')
ON CONFLICT (key) DO NOTHING;
