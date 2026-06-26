-- 20260625_jarvis_future_builds.sql
-- Future Builds / Idea Queue: capture product ideas from research, Heath, customers, agent findings
-- to prevent loss in scattered memory files. Visible in Jarvis HUD.

CREATE TABLE IF NOT EXISTS public.jarvis_future_builds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,

  -- Core idea metadata
  title text NOT NULL,
  description text,
  source text NOT NULL,
  score integer,

  -- Workflow: idea → queued → dod_drafting → building → shipped
  status text NOT NULL DEFAULT 'idea' CHECK (status IN ('idea', 'queued', 'dod_drafting', 'building', 'shipped', 'rejected')),

  -- Context + blockers
  source_doc_path text,
  prerequisite text,
  bridges_personal_assistant boolean DEFAULT false,

  -- Audit
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,

  FOREIGN KEY (tenant_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- Column comments (Postgres style)
COMMENT ON COLUMN jarvis_future_builds.source IS 'e.g., "pierce_5 research", "Heath direct idea", "customer request", "atlas finding"';
COMMENT ON COLUMN jarvis_future_builds.score IS 'agent-assigned rank (e.g., REALTOR×personal×ease×network score)';
COMMENT ON COLUMN jarvis_future_builds.source_doc_path IS 'Link to research file in Shepard-Ventures/ (e.g., Marketing/research/2026-06-24-realtor-to-personal-assistant-integrations.md)';
COMMENT ON COLUMN jarvis_future_builds.prerequisite IS 'Blockers (e.g., "blocked by Dossie Sign")';
COMMENT ON COLUMN jarvis_future_builds.bridges_personal_assistant IS 'Flag for REALTOR-to-personal candidates';

-- Indexes for fast querying
CREATE INDEX IF NOT EXISTS idx_jarvis_future_builds_tenant
  ON public.jarvis_future_builds(tenant_id, archived_at) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_jarvis_future_builds_status
  ON public.jarvis_future_builds(tenant_id, status) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_jarvis_future_builds_created
  ON public.jarvis_future_builds(tenant_id, created_at DESC);

-- RLS: Heath can see + update status/score/description; agents + Cole create via service role
ALTER TABLE public.jarvis_future_builds ENABLE ROW LEVEL SECURITY;

-- SELECT: Heath only (tenant_id = auth.uid())
CREATE POLICY "heath_select_own_builds"
  ON public.jarvis_future_builds
  FOR SELECT
  USING (tenant_id = auth.uid());

-- UPDATE: Heath only (status changes, score, description refinement)
CREATE POLICY "heath_update_own_builds"
  ON public.jarvis_future_builds
  FOR UPDATE
  USING (tenant_id = auth.uid())
  WITH CHECK (tenant_id = auth.uid());

-- INSERT + DELETE: service role only (Cole + agents)
CREATE POLICY "service_role_write"
  ON public.jarvis_future_builds
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Realtime: updates to status, score, description
ALTER TABLE public.jarvis_future_builds REPLICA IDENTITY FULL;
