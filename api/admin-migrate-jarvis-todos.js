// One-time migration: create public.jarvis_todos (Heath's real to-do list
// on the Jarvis PWA HUD — see supabase/migrations/20260812_jarvis_todos.sql
// for full commentary). Safe to re-run — every statement is IF NOT EXISTS /
// OR REPLACE / DROP-then-CREATE, no data touched.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-08-12 (SV-ENG-JARVIS-TODOS)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
CREATE TABLE IF NOT EXISTS public.jarvis_todos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  detail      TEXT,
  done        BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.jarvis_todos IS
  'Heath''s real to-do list on the Jarvis PWA HUD. Multi-item, manually editable in the UI, and directly writable by Jarvis via generic Supabase MCP access during conversation. Keep the schema plain -- an LLM issuing generic Supabase queries needs to be able to insert/update/delete a row correctly from the column names alone.';
COMMENT ON COLUMN public.jarvis_todos.title IS
  'One-line summary shown collapsed in the UI.';
COMMENT ON COLUMN public.jarvis_todos.detail IS
  'Optional longer description shown when the item is expanded. Nullable.';
COMMENT ON COLUMN public.jarvis_todos.done IS
  'true = completed. Done items stay in the table (sorted to the bottom) rather than being deleted, so nothing gets silently lost.';

CREATE INDEX IF NOT EXISTS idx_jarvis_todos_open
  ON public.jarvis_todos (done, created_at DESC);

CREATE OR REPLACE FUNCTION public.jarvis_todos_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jarvis_todos_touch_updated_at ON public.jarvis_todos;
CREATE TRIGGER trg_jarvis_todos_touch_updated_at
  BEFORE UPDATE ON public.jarvis_todos
  FOR EACH ROW EXECUTE FUNCTION public.jarvis_todos_touch_updated_at();

ALTER TABLE public.jarvis_todos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view jarvis_todos" ON public.jarvis_todos;
CREATE POLICY "Authenticated users can view jarvis_todos"
  ON public.jarvis_todos FOR SELECT
  USING ((select auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can insert jarvis_todos" ON public.jarvis_todos;
CREATE POLICY "Authenticated users can insert jarvis_todos"
  ON public.jarvis_todos FOR INSERT
  WITH CHECK ((select auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can update jarvis_todos" ON public.jarvis_todos;
CREATE POLICY "Authenticated users can update jarvis_todos"
  ON public.jarvis_todos FOR UPDATE
  USING ((select auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can delete jarvis_todos" ON public.jarvis_todos;
CREATE POLICY "Authenticated users can delete jarvis_todos"
  ON public.jarvis_todos FOR DELETE
  USING ((select auth.role()) = 'authenticated');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'jarvis_todos'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.jarvis_todos;
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
      message: 'jarvis_todos table created (or already existed) with RLS + realtime',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to create jarvis_todos',
      details: err.message,
    });
  }
};
