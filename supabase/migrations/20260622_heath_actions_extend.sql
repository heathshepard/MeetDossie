-- Extend heath_actions table for structured action execution (email sends, refunds, etc.)
-- Added columns: action_type, payload, approved_at, executed_at, execution_result

ALTER TABLE public.heath_actions ADD COLUMN IF NOT EXISTS action_type TEXT DEFAULT 'manual'
  CHECK (action_type IN ('manual', 'send_email', 'send_telegram', 'process_refund', 'execute_purchase'));

ALTER TABLE public.heath_actions ADD COLUMN IF NOT EXISTS payload JSONB;

ALTER TABLE public.heath_actions ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

ALTER TABLE public.heath_actions ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;

ALTER TABLE public.heath_actions ADD COLUMN IF NOT EXISTS execution_result JSONB;

-- Index on action_type + status for efficient querying of pending executable actions
CREATE INDEX IF NOT EXISTS idx_heath_actions_type_status
  ON public.heath_actions(action_type, status);

-- Index on approved_at for sorting completed/executed actions
CREATE INDEX IF NOT EXISTS idx_heath_actions_approved_at
  ON public.heath_actions(approved_at);
