-- 2026-07-06 ATLAS — Add owner_notified_at for idempotent agent-executed contract email.
-- The webhook fires an "agent got executed contract with PDF attached" email exactly once
-- per envelope completion, gated by this timestamp being null.
ALTER TABLE public.signature_requests
  ADD COLUMN IF NOT EXISTS owner_notified_at timestamp with time zone;
COMMENT ON COLUMN public.signature_requests.owner_notified_at IS
  'Timestamp when the transaction owner (agent) was emailed the executed contract with the signed PDF. Idempotency gate for esign-webhook agent-executed email path.';
