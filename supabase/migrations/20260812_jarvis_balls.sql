-- ============================================================================
-- jarvis_balls — "Balls in the Air" board on the Jarvis PWA HUD.
--
-- One row per active thread/deal/project Heath is juggling across his
-- businesses (Brokerage, Dossie, Rust, Sawyer, Jarvis itself). Pinned at the
-- very top of the page, above the jarvis_todos to-do list. Purpose: Heath
-- can see at a glance whose court each thing is in, and how long it's been
-- sitting there, so he catches "waiting on someone else for a day or two"
-- before it goes stale.
--
-- Primary write path is CONVERSATIONAL: Heath tells this Jarvis session
-- "I sent that to John" and the session updates the matching row's court +
-- status_note directly via its generic Supabase MCP access (separate task,
-- same mechanism as jarvis_todos). Schema is kept deliberately plain for
-- that reason — no enums beyond a loose CHECK on business_tag, no separate
-- lookup tables, nothing an LLM has to look up before it can write a row.
--
-- Owner: Carter (SV-ENG-JARVIS-BALLS / 2026-08-12)
-- ============================================================================

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
  'Heath''s "Balls in the Air" board on the Jarvis PWA HUD -- one row per active thread/deal across his businesses. Updated conversationally by Jarvis via generic Supabase MCP access (e.g. Heath says "I sent that to John" -> court + status_note updated). Keep the schema plain -- an LLM issuing generic Supabase queries needs to be able to update a row correctly from the column names alone.';
COMMENT ON COLUMN public.jarvis_balls.name IS
  'One-line label for the thread, e.g. "Nopalito -- John''s 1%".';
COMMENT ON COLUMN public.jarvis_balls.business_tag IS
  'Which business this belongs to -- brokerage | dossie | rust | sawyer | jarvis. Drives the color-coded tag in the UI.';
COMMENT ON COLUMN public.jarvis_balls.court IS
  'Whose move it is. Literal string "you" means Heath; anything else is a person''s name (e.g. "John Rodriguez"). UI flags "you" in a warm/red color and everyone else in a neutral/cool color.';
COMMENT ON COLUMN public.jarvis_balls.status_note IS
  'One line: what''s actually next / the last thing that happened. Nullable.';
COMMENT ON COLUMN public.jarvis_balls.last_updated IS
  'When the court/status last changed. Auto-refreshed to NOW() on every UPDATE by trigger below -- Jarvis does not need to set this itself, just update court/status_note and the "waiting since" timer resets automatically.';

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

-- RLS: any authenticated user (single-tenant app -- only Heath has an
-- account). Matches the jarvis_todos convention (20260812_jarvis_todos.sql).
ALTER TABLE public.jarvis_balls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view jarvis_balls"
  ON public.jarvis_balls FOR SELECT
  USING ((select auth.role()) = 'authenticated');

CREATE POLICY "Authenticated users can insert jarvis_balls"
  ON public.jarvis_balls FOR INSERT
  WITH CHECK ((select auth.role()) = 'authenticated');

CREATE POLICY "Authenticated users can update jarvis_balls"
  ON public.jarvis_balls FOR UPDATE
  USING ((select auth.role()) = 'authenticated');

CREATE POLICY "Authenticated users can delete jarvis_balls"
  ON public.jarvis_balls FOR DELETE
  USING ((select auth.role()) = 'authenticated');

ALTER PUBLICATION supabase_realtime ADD TABLE public.jarvis_balls;
