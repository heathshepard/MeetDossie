-- Warm-touch queue: leads to engage on social before cold-emailing.
-- The cron-warm-touch-queue job populates this; the LinkedIn engager
-- picks up pending rows and marks them engaged. The cold email batch
-- job prioritizes leads who were engaged >= 3 days ago.

CREATE TABLE IF NOT EXISTS public.warm_touch_queue (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_email    text NOT NULL,
  lead_name     text NOT NULL,
  lead_city     text DEFAULT 'San Antonio',
  lead_brokerage text DEFAULT '',
  platform      text DEFAULT 'linkedin',
  profile_url   text,
  status        text DEFAULT 'pending'
                  CHECK (status IN ('pending', 'engaged', 'skipped', 'not_found')),
  engaged_at    timestamptz,
  created_at    timestamptz DEFAULT now(),
  UNIQUE (lead_email, platform)
);

CREATE INDEX IF NOT EXISTS idx_warm_touch_status ON public.warm_touch_queue (status);
CREATE INDEX IF NOT EXISTS idx_warm_touch_engaged ON public.warm_touch_queue (engaged_at)
  WHERE engaged_at IS NOT NULL;

ALTER TABLE public.warm_touch_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY warm_touch_service_all ON public.warm_touch_queue
  FOR ALL USING (true) WITH CHECK (true);
