-- ============================================================================
-- jarvis_todos — Heath's real, multi-item to-do list on the Jarvis PWA HUD.
--
-- Distinct from two existing, differently-shaped tables that also render
-- "to-do"-ish UI on this page — do not confuse or merge them:
--   - heath_todo    : agent-populated SINGLE-item-at-a-time work queue
--                     (Cole/other agents queue tasks, Heath sees one at a
--                     time with Done/Skip/Snooze). Unchanged by this file.
--   - heath_actions : approval-style queue (urgent/soon/whenever, email
--                     approvals etc). Unchanged by this file.
--
-- jarvis_todos is the plain list Heath asked for 2026-08-12: he can add /
-- edit / remove items himself from the PWA, AND he can just talk to Jarvis
-- and have it add/remove/update rows here directly — the jarvis-bridge
-- Claude Code session gets generic Supabase query/write access via the
-- standard `supabase` MCP server (separate task). Schema is deliberately
-- plain (title/detail/done) so a model can insert/update a row correctly
-- from the column names alone, no bespoke tool needed.
--
-- Single-user app (Heath only has an account in this Supabase project) —
-- no tenant_id column. RLS scopes to "any authenticated user" rather than
-- a specific uid, matching the single-tenant reality; service_role (used by
-- the jarvis-bridge MCP session) bypasses RLS entirely at the Postgres level
-- regardless.
--
-- Owner: Carter (SV-ENG-JARVIS-TODOS / 2026-08-12)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.jarvis_todos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  detail      TEXT,
  done        BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.jarvis_todos IS
  'Heath''s real to-do list on the Jarvis PWA HUD. Multi-item, manually editable in the UI, and directly writable by Jarvis via generic Supabase MCP access during conversation. Keep the schema plain — an LLM issuing generic Supabase queries needs to be able to insert/update/delete a row correctly from the column names alone.';
COMMENT ON COLUMN public.jarvis_todos.title IS
  'One-line summary shown collapsed in the UI.';
COMMENT ON COLUMN public.jarvis_todos.detail IS
  'Optional longer description shown when the item is expanded. Nullable.';
COMMENT ON COLUMN public.jarvis_todos.done IS
  'true = completed. Done items stay in the table (sorted to the bottom) rather than being deleted, so nothing gets silently lost.';

-- Picker index: open items first, newest first within that.
CREATE INDEX IF NOT EXISTS idx_jarvis_todos_open
  ON public.jarvis_todos (done, created_at DESC);

-- Keep updated_at honest even if a writer forgets to set it (e.g. a plain
-- Supabase MCP UPDATE that only touches title/detail/done).
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

-- RLS: any authenticated user may read/write (single-tenant app — only
-- Heath has an account). Matches the auth.role() pattern already used
-- elsewhere in this schema; auth.role() wrapped in (select ...) per the
-- 2026-08-06 advisor lockdown convention to avoid the auth_rls_initplan
-- warning. service_role (jarvis-bridge MCP) bypasses RLS regardless.
ALTER TABLE public.jarvis_todos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view jarvis_todos"
  ON public.jarvis_todos FOR SELECT
  USING ((select auth.role()) = 'authenticated');

CREATE POLICY "Authenticated users can insert jarvis_todos"
  ON public.jarvis_todos FOR INSERT
  WITH CHECK ((select auth.role()) = 'authenticated');

CREATE POLICY "Authenticated users can update jarvis_todos"
  ON public.jarvis_todos FOR UPDATE
  USING ((select auth.role()) = 'authenticated');

CREATE POLICY "Authenticated users can delete jarvis_todos"
  ON public.jarvis_todos FOR DELETE
  USING ((select auth.role()) = 'authenticated');

-- Realtime — PWA subscribes so Jarvis-added/removed items show up live
-- without waiting on the polling fallback.
ALTER PUBLICATION supabase_realtime ADD TABLE public.jarvis_todos;
