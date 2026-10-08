-- outbound_email_queue: additive columns so member transaction email (today
-- a dead-end post-hoc log into email_queue, written by api/send-email.js)
-- can use the SAME proven table as the cold-email/marketing machine instead
-- of a second, broken, write-only queue.
--
-- Why additive and not a rename/reuse of an existing column
-- -----------------------------------------------------------
-- outbound_email_queue was built for one identity: Heath's own cold-outreach
-- (hardcoded "Heath at Dossie" sender, BCC heath@meetdossie.com by default —
-- see api/_lib/outbound-email-send.js). Member transaction email needs a
-- DIFFERENT identity per row (the agent's own name, "{name} via Dossie",
-- no BCC) and needs to know WHICH member/dossier it belongs to so the
-- existing per-customer digest/badge/ops-metric queries can filter by it.
-- None of that existed on this table. Every column below is NULLable with
-- no default (except `kind`), so every row written by the cold-email/
-- marketing path today is completely unaffected — this is purely additive.
--
-- `kind` is NOT NULL DEFAULT 'cold_outreach' specifically so the sender
-- function (sendOutboundEmailRow) can branch on an explicit, self-documenting
-- value instead of sniffing metadata.queued_by string patterns, which is
-- fragile and easy for a future caller to get wrong in the direction that
-- leaks Heath's identity onto a customer-facing email (or vice versa).
--
-- Safe to re-run: every ADD COLUMN is IF NOT EXISTS.

ALTER TABLE public.outbound_email_queue
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'cold_outreach';

ALTER TABLE public.outbound_email_queue
  ADD COLUMN IF NOT EXISTS user_id UUID;

ALTER TABLE public.outbound_email_queue
  ADD COLUMN IF NOT EXISTS transaction_id TEXT;

ALTER TABLE public.outbound_email_queue
  ADD COLUMN IF NOT EXISTS to_name TEXT;

ALTER TABLE public.outbound_email_queue
  ADD COLUMN IF NOT EXISTS from_display_name TEXT;

COMMENT ON COLUMN public.outbound_email_queue.kind IS
  'Row class, drives sender identity in sendOutboundEmailRow(). "cold_outreach" (default, existing behavior, unchanged) = Heath-branded, BCC heath@meetdossie.com. "member_transaction" (new, 2026-10-08) = {from_display_name} via Dossie <dossie@meetdossie.com>, no BCC (customer-file operational email).';
COMMENT ON COLUMN public.outbound_email_queue.user_id IS
  'Member/agent owner for a member_transaction row. NULL on cold_outreach rows (those are Heath''s own, not member-scoped).';
COMMENT ON COLUMN public.outbound_email_queue.transaction_id IS
  'Dossier this email belongs to, for member_transaction rows (text, matches transactions.id serialized). NULL on cold_outreach rows.';
COMMENT ON COLUMN public.outbound_email_queue.to_name IS
  'Recipient display name for member_transaction rows (e.g. the buyer/seller name). Optional, display-only.';
COMMENT ON COLUMN public.outbound_email_queue.from_display_name IS
  'Agent''s own name for member_transaction rows, rendered as "{from_display_name} via Dossie". NULL falls back to plain "Dossie".';

CREATE INDEX IF NOT EXISTS idx_outbound_email_queue_kind_user
  ON public.outbound_email_queue (kind, user_id);
