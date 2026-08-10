-- ============================================================================
-- Additive, nullable business_line classifier on agent_queue.
--
-- WHY: The Jarvis task-visualization panel (myjarvis) needs to group live
-- agent_queue rows by business line (Dossie / Sawyer / Brokerage / Trading /
-- Shepard Ventures HQ) so Heath can see what each part of the portfolio is
-- doing at a glance. This is DISTINCT from the existing `venture` column
-- (caller-supplied free text: dossie/paralegal/personal-agents/
-- shepard-ventures/general) — business_line is derived server-side from
-- agent_name via a fixed lookup (see api/_lib/business-line.js), not
-- caller-supplied, so it can't drift the way `venture` sometimes does.
--
-- Old rows are left NULL — the UI treats NULL as 'shepard-ventures'
-- (uncategorized bucket). No backfill required per scope.
--
-- Owner: Atlas, 2026-08-10 (SV-ENG-JARVIS-TASK-VIZ)
-- ============================================================================

ALTER TABLE agent_queue ADD COLUMN IF NOT EXISTS business_line TEXT;

ALTER TABLE agent_queue DROP CONSTRAINT IF EXISTS agent_queue_business_line_check;
ALTER TABLE agent_queue ADD CONSTRAINT agent_queue_business_line_check
  CHECK (business_line IS NULL OR business_line IN (
    'dossie', 'sawyer', 'brokerage', 'trading', 'shepard-ventures'
  ));

COMMENT ON COLUMN agent_queue.business_line IS
  'Server-derived business-line bucket for the Jarvis task-viz panel: dossie|sawyer|brokerage|trading|shepard-ventures. Set via api/_lib/business-line.js at enqueue time from agent_name (cole/warden/content-verifier inherit an explicit caller value or default to shepard-ventures). NULL on rows enqueued before 2026-08-10 — UI treats NULL as shepard-ventures.';

-- Query pattern the panel uses: rows for one business line, newest first,
-- filtered to a status bucket (running/queued/recently-completed).
CREATE INDEX IF NOT EXISTS idx_agent_queue_business_line
  ON agent_queue (business_line, status, created_at DESC);
