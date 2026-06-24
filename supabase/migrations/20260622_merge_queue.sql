-- 20260622_merge_queue.sql
-- Merge queue system: visible tracking of staging->main merge candidates
-- with sign-off tracking from Atlas APV, Quinn QA, Ridge reliability, Hadley acceptance, Sage demo

CREATE TABLE IF NOT EXISTS public.merge_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'heath',

  -- Git metadata
  commit_sha text NOT NULL UNIQUE,
  branch_from text NOT NULL DEFAULT 'staging',
  branch_to text NOT NULL DEFAULT 'main',
  title text,
  description text,
  commit_author text,
  committed_at timestamptz,

  -- Sign-off tracking (each is: not_run | pass | fail)
  atlas_apv_status text NOT NULL DEFAULT 'not_run',
  atlas_apv_evidence_url text,
  atlas_apv_notes text,

  quinn_qa_status text NOT NULL DEFAULT 'not_run',
  quinn_qa_evidence_url text,
  quinn_qa_notes text,

  ridge_status text NOT NULL DEFAULT 'not_run',
  ridge_evidence_url text,
  ridge_notes text,

  hadley_status text NOT NULL DEFAULT 'not_run',
  hadley_evidence_url text,
  hadley_notes text,

  sage_demo_status text NOT NULL DEFAULT 'not_run',
  sage_demo_video_url text,
  sage_demo_notes text,

  -- Computed: all five = pass => enabled merge button
  all_green boolean GENERATED ALWAYS AS (
    atlas_apv_status = 'pass'
    AND quinn_qa_status = 'pass'
    AND ridge_status = 'pass'
    AND hadley_status = 'pass'
    AND sage_demo_status = 'pass'
  ) STORED,

  -- Merge tracking
  merged_to_main boolean NOT NULL DEFAULT false,
  merged_at timestamptz,
  merged_by_user_id text,

  -- Audit
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_merge_queue_tenant ON public.merge_queue(tenant_id);
CREATE INDEX IF NOT EXISTS idx_merge_queue_all_green ON public.merge_queue(all_green) WHERE merged_to_main = false;
CREATE INDEX IF NOT EXISTS idx_merge_queue_created ON public.merge_queue(created_at DESC);

-- RLS: service role only (Cole/agents + system APIs)
ALTER TABLE public.merge_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full" ON public.merge_queue
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Realtime: updates to sign-off statuses and merge_to_main
ALTER TABLE public.merge_queue REPLICA IDENTITY FULL;
