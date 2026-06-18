-- Fix 2: Add RLS policy for agent_state (currently has RLS enabled but no policy)
CREATE POLICY agent_state_heath_only ON public.agent_state
  FOR SELECT
  USING (auth.uid() = '0cd05e2f-491f-411f-afe7-f8d3fbbdbff6');

-- Fix 3: Enable RLS on decision_queue and add Heath-only policy
ALTER TABLE public.decision_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY decision_queue_heath_only ON public.decision_queue
  FOR ALL
  USING (auth.uid() = '0cd05e2f-491f-411f-afe7-f8d3fbbdbff6')
  WITH CHECK (auth.uid() = '0cd05e2f-491f-411f-afe7-f8d3fbbdbff6');
