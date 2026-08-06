-- ============================================================================
-- agent_queue: add 'pending_audit' status — worker → auditor handoff
--
-- Purpose: close the loop Heath approved 2026-08-06 (proactive-work +
-- audit-loop system). Worker completion no longer jumps straight to
-- 'completed' — it lands in 'pending_audit' so Quinn (real tool-enabled
-- session via the local poller) can verify the work before it's final.
-- Quinn's verdict either flips it to 'completed' (pass) or back to 'pending'
-- (fail — same agent_name, so it routes back to the original agent
-- automatically for a refix).
--
-- State machine (updated):
--   pending → in_progress → pending_audit → completed
--                         ↘ blocked            ↑
--           ↘ cancelled         pending (fail) ┘  (up to 3 retries, then
--                                                   blocked + escalate)
--
-- Exceptions: quinn's own tasks skip the audit hop (quinn auditing quinn is
-- a no-op / infinite-loop risk) and any task tagged metadata.skip_audit=true.
--
-- Owner: Atlas, 2026-08-06 (SV-ENG-AGENT-QUEUE-AUDIT-LOOP).
-- ============================================================================

DO $$
DECLARE
  cname text;
BEGIN
  -- Find the existing status CHECK constraint by inspecting its definition
  -- rather than guessing the auto-generated name.
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'agent_queue'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%status%pending%in_progress%';

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE agent_queue DROP CONSTRAINT %I', cname);
  END IF;

  ALTER TABLE agent_queue
    ADD CONSTRAINT agent_queue_status_check
    CHECK (status IN (
      'pending', 'in_progress', 'pending_audit',
      'blocked', 'completed', 'cancelled'
    ));
END $$;

COMMENT ON COLUMN agent_queue.status IS
  'pending -> in_progress -> pending_audit -> completed (Quinn pass) | pending (Quinn fail, same agent_name so it auto-routes back) -> blocked (cancelled terminal state, or audit retries exhausted, metadata._escalate_to_heath=true).';
