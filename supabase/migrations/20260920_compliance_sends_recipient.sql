-- compliance_sends: record WHO a packet went to, not just that one went out.
--
-- The table was built when this endpoint could only ever mail the member's
-- own brokerage compliance address, so the recipient needed no describing.
-- It can now send to a named party on the deal (seller, cooperating agent,
-- title, lender), which makes "who received this" an auditable fact worth
-- storing rather than inferring from an email address alone.
--
-- All three columns are nullable with no default beyond dry_run's, so
-- existing rows stay valid and a deployment running ahead of this migration
-- still logs via the base-column fallback in api/send-compliance-packet.js.

ALTER TABLE public.compliance_sends
  ADD COLUMN IF NOT EXISTS sent_to_name   text,
  ADD COLUMN IF NOT EXISTS recipient_role text,
  ADD COLUMN IF NOT EXISTS dry_run        boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.compliance_sends.recipient_role IS
  'Party role the packet was addressed to (seller, buyer, listing_agent, other_agent, title, lender, compliance, self). Resolved server-side from the transaction record; never free text from a model.';

COMMENT ON COLUMN public.compliance_sends.dry_run IS
  'True when the packet was assembled but deliberately not handed to the mail provider. Dry-run rows are NOT evidence of delivery and must be excluded from any "was this sent" check.';

-- Anything asking "did this actually go out" wants a real provider message id
-- and a non-dry-run row. Partial index keeps that lookup cheap.
CREATE INDEX IF NOT EXISTS compliance_sends_delivered_idx
  ON public.compliance_sends (transaction_id, sent_at DESC)
  WHERE resend_message_id IS NOT NULL AND dry_run = false;
