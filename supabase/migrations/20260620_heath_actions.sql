-- Create heath_actions table for tracking action items Heath needs to complete
-- Schema: id, tenant_id, title, body, source, priority, deadline, status, created_at, completed_at, snoozed_until, evidence_url

CREATE TABLE IF NOT EXISTS public.heath_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  source TEXT NOT NULL COMMENT 'e.g., "cole_jarvis_orchestrator", "atlas_5", "hadley_2"',
  priority TEXT NOT NULL DEFAULT 'whenever' CHECK (priority IN ('urgent', 'soon', 'whenever')),
  deadline TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'dismissed', 'snoozed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  snoozed_until TIMESTAMPTZ,
  evidence_url TEXT,
  FOREIGN KEY (tenant_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- Enable RLS
ALTER TABLE public.heath_actions ENABLE ROW LEVEL SECURITY;

-- RLS policy: users can only see their own actions
CREATE POLICY "Users can view their own actions"
  ON public.heath_actions
  FOR SELECT
  USING (tenant_id = auth.uid());

CREATE POLICY "Users can update their own actions"
  ON public.heath_actions
  FOR UPDATE
  USING (tenant_id = auth.uid());

CREATE POLICY "Users can insert their own actions"
  ON public.heath_actions
  FOR INSERT
  WITH CHECK (tenant_id = auth.uid());

-- Create index on tenant_id + status for fast querying
CREATE INDEX idx_heath_actions_tenant_status
  ON public.heath_actions(tenant_id, status);

-- Create index on deadline for sorting
CREATE INDEX idx_heath_actions_deadline
  ON public.heath_actions(tenant_id, deadline);

-- Enable realtime for this table
ALTER PUBLICATION supabase_realtime ADD TABLE public.heath_actions;
