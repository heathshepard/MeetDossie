-- ============================================================================
-- heath_todo — Heath's personal single-item-at-a-time task queue
--
-- Purpose: The Jarvis HUD needs to show Heath ONE thing to do at a time.
-- Cole (and other agents) populate this constantly as action items come up:
--   "Text Lisa", "Approve emails", "Decide VPS provider", "Paste env keys", etc.
--
-- Heath taps [Done] | [Skip] | [Snooze] on the HUD. Next item auto-loads.
-- This is a sibling of agent_queue but for Heath himself rather than the agents.
--
-- Picker contract (mirrors agent_queue):
--   highest priority (lowest int) first, then oldest created_at first,
--   eligibility = status='pending' AND (snoozed_until IS NULL OR snoozed_until <= now()).
--
-- Owner: Atlas (SV-ENG-HEATH-TODO / 2026-06-17)
-- ============================================================================

CREATE TABLE IF NOT EXISTS heath_todo (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      TEXT NOT NULL DEFAULT 'cole',
  title           TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  detail          TEXT,
  action_type     TEXT NOT NULL DEFAULT 'other'
                  CHECK (action_type IN (
                    'sms','email','approve','decision','install','other'
                  )),
  priority        INT NOT NULL DEFAULT 3
                  CHECK (priority BETWEEN 1 AND 5),
  deadline        TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','done','skipped','snoozed')),
  completed_at    TIMESTAMPTZ,
  snoozed_until   TIMESTAMPTZ,
  venture         TEXT NOT NULL DEFAULT 'general'
                  CHECK (venture IN (
                    'dossie','paralegal','personal-agents',
                    'shepard-ventures','general'
                  )),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Picker index: pending items sorted by priority then created_at
CREATE INDEX IF NOT EXISTS idx_heath_todo_pending_pick
  ON heath_todo (status, priority, created_at)
  WHERE status = 'pending';

-- Snooze-resurrection index: cron sweeps these to flip back to pending
CREATE INDEX IF NOT EXISTS idx_heath_todo_snoozed
  ON heath_todo (snoozed_until)
  WHERE status = 'snoozed';

COMMENT ON TABLE heath_todo IS
  'Heath''s personal task queue. Jarvis HUD shows one at a time. Cole + other agents queue items.';
COMMENT ON COLUMN heath_todo.priority IS
  '1=critical, 2=high, 3=normal, 4=low, 5=background. Lower = picked first.';
COMMENT ON COLUMN heath_todo.action_type IS
  'sms | email | approve | decision | install | other — used by HUD to pick icon + helper UI.';
COMMENT ON COLUMN heath_todo.snoozed_until IS
  'When status=snoozed, the cron will flip back to pending once now() >= this timestamp.';

-- RLS: service-role only. Every API endpoint runs with service role and
-- verifies Heath's JWT (heath.shepard@kw.com only) or CRON_SECRET in code.
ALTER TABLE heath_todo ENABLE ROW LEVEL SECURITY;
-- (no policies)

-- Helper view: items eligible to pick right now (pending OR snooze expired).
-- We intentionally don't flip snoozed -> pending here — a cron does that —
-- but we surface them as pickable so the HUD never misses a wake-up.
CREATE OR REPLACE VIEW heath_todo_ready AS
SELECT *
FROM heath_todo
WHERE status = 'pending'
   OR (status = 'snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= NOW());

COMMENT ON VIEW heath_todo_ready IS
  'All items Heath could see right now. HUD reads via /api/heath-todo-next which sorts by priority,created_at LIMIT 1.';
