// One-time migration: create public.jarvis_balls ("Balls in the Air" board on
// the Jarvis PWA HUD) — see supabase/migrations/20260812_jarvis_balls.sql for
// full commentary. Safe to re-run — every statement is IF NOT EXISTS /
// OR REPLACE / DROP-then-CREATE, no data touched.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-08-12 (SV-ENG-JARVIS-BALLS)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
CREATE TABLE IF NOT EXISTS public.jarvis_balls (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  business_tag  TEXT NOT NULL DEFAULT 'brokerage'
                CHECK (business_tag IN ('brokerage','dossie','rust','sawyer','jarvis')),
  court         TEXT NOT NULL DEFAULT 'you' CHECK (length(court) BETWEEN 1 AND 100),
  status_note   TEXT,
  last_updated  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.jarvis_balls IS
  'Heath''s "Balls in the Air" board on the Jarvis PWA HUD -- one row per active thread/deal across his businesses. Updated conversationally by Jarvis via generic Supabase MCP access. Keep the schema plain -- an LLM issuing generic Supabase queries needs to be able to update a row correctly from the column names alone.';
COMMENT ON COLUMN public.jarvis_balls.name IS
  'One-line label for the thread, e.g. "Nopalito -- John''s 1%".';
COMMENT ON COLUMN public.jarvis_balls.business_tag IS
  'Which business this belongs to -- brokerage | dossie | rust | sawyer | jarvis.';
COMMENT ON COLUMN public.jarvis_balls.court IS
  'Whose move it is. Literal string "you" means Heath; anything else is a person''s name.';
COMMENT ON COLUMN public.jarvis_balls.status_note IS
  'One line: what''s actually next / the last thing that happened. Nullable.';
COMMENT ON COLUMN public.jarvis_balls.last_updated IS
  'Auto-refreshed to NOW() on every UPDATE by trigger below.';

CREATE INDEX IF NOT EXISTS idx_jarvis_balls_last_updated
  ON public.jarvis_balls (last_updated DESC);

CREATE OR REPLACE FUNCTION public.jarvis_balls_touch_last_updated()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_updated := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jarvis_balls_touch_last_updated ON public.jarvis_balls;
CREATE TRIGGER trg_jarvis_balls_touch_last_updated
  BEFORE UPDATE ON public.jarvis_balls
  FOR EACH ROW EXECUTE FUNCTION public.jarvis_balls_touch_last_updated();

ALTER TABLE public.jarvis_balls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view jarvis_balls" ON public.jarvis_balls;
CREATE POLICY "Authenticated users can view jarvis_balls"
  ON public.jarvis_balls FOR SELECT
  USING ((select auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can insert jarvis_balls" ON public.jarvis_balls;
CREATE POLICY "Authenticated users can insert jarvis_balls"
  ON public.jarvis_balls FOR INSERT
  WITH CHECK ((select auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can update jarvis_balls" ON public.jarvis_balls;
CREATE POLICY "Authenticated users can update jarvis_balls"
  ON public.jarvis_balls FOR UPDATE
  USING ((select auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can delete jarvis_balls" ON public.jarvis_balls;
CREATE POLICY "Authenticated users can delete jarvis_balls"
  ON public.jarvis_balls FOR DELETE
  USING ((select auth.role()) = 'authenticated');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'jarvis_balls'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.jarvis_balls;
  END IF;
END $$;
`;

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(SQL);
    return res.status(200).json({
      ok: true,
      message: 'jarvis_balls table created (or already existed) with RLS + realtime',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to create jarvis_balls',
      details: err.message,
    });
  }
};
