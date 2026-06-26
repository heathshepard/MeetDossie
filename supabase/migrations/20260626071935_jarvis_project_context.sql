-- 20260626071935_jarvis_project_context.sql
-- Project Context table: a Supabase-mirrored representation of the project/memory
-- files that live filesystem-only in ~/.claude/projects/<repo>/memory/. Jarvis-voice
-- pulls a top-priority slice into the dynamic suffix of its system prompt so the
-- voice assistant can speak about paused initiatives, active strategic projects,
-- and customer roster facts without hallucinating.
--
-- Owner: Atlas, 2026-06-26 (atlas_12 — Jarvis Project Context federation).
--
-- Source incident: 2026-06-25. Heath asked Jarvis about the cold-email-to-TX-
-- agents campaign. Jarvis said "still need to sign up for Apollo / Instantly" —
-- ignoring the 2026-06-24 decision to PAUSE the entire plan. That decision lived
-- only in a filesystem memory file Jarvis can't read.

CREATE TABLE IF NOT EXISTS public.jarvis_project_context (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,

  -- Identity
  key text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,

  -- Workflow
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'blocked', 'shipped', 'archived')),

  -- Curation
  priority int NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  tags text[] NOT NULL DEFAULT '{}',

  -- Provenance + sync
  source_memory_path text,

  -- Lifecycle
  last_updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Uniqueness: one row per (tenant, key) so upserts work cleanly
  CONSTRAINT jarvis_project_context_tenant_key_unique UNIQUE (tenant_id, key),

  -- FK: tenants.id (multitenant pattern, mirrors jarvis_projects)
  FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE
);

COMMENT ON TABLE public.jarvis_project_context IS
  'Strategic project + decision context surfaced to jarvis-voice. Mirrors filesystem memory files (~/.claude/projects/<repo>/memory/) so Jarvis can speak about paused/active initiatives without hallucinating.';
COMMENT ON COLUMN public.jarvis_project_context.key IS
  'Stable slug-cased identifier, e.g. "cold-email-tx-agents-paused". Used for upsert idempotency.';
COMMENT ON COLUMN public.jarvis_project_context.summary IS
  '1-3 sentence speakable summary. Jarvis may quote verbatim in voice replies.';
COMMENT ON COLUMN public.jarvis_project_context.status IS
  'active = ongoing; paused = explicitly halted by Heath; blocked = waiting on dependency; shipped = done; archived = no longer relevant.';
COMMENT ON COLUMN public.jarvis_project_context.priority IS
  '1 = top of federation (always surfaced), 5 = backlog (only surfaced when room).';
COMMENT ON COLUMN public.jarvis_project_context.source_memory_path IS
  'Relative path to originating memory file under .claude/projects/, so Cole can keep them in sync.';
COMMENT ON COLUMN public.jarvis_project_context.expires_at IS
  'Optional staleness timestamp. When set and now() > expires_at, the federation should skip this row.';

-- Indexes for the federation query: filter by tenant, status, then order by priority + recency.
CREATE INDEX IF NOT EXISTS idx_jarvis_project_context_tenant_status_priority
  ON public.jarvis_project_context(tenant_id, status, priority, last_updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_jarvis_project_context_key
  ON public.jarvis_project_context(tenant_id, key);

CREATE INDEX IF NOT EXISTS idx_jarvis_project_context_tags
  ON public.jarvis_project_context USING gin (tags);

-- RLS
ALTER TABLE public.jarvis_project_context ENABLE ROW LEVEL SECURITY;

-- SELECT: authenticated users see rows whose tenant_id matches one of their
-- jarvis_users.tenant_id entries. Mirrors the pattern used by jarvis_projects.
CREATE POLICY "user_select_own_tenant_context"
  ON public.jarvis_project_context
  FOR SELECT
  USING (
    tenant_id IN (
      SELECT tenant_id FROM public.jarvis_users WHERE auth_user_id = auth.uid()
    )
  );

-- INSERT / UPDATE / DELETE: service role only (Cole + agent endpoints).
CREATE POLICY "service_role_all"
  ON public.jarvis_project_context
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Realtime: change-stream so HUD can react to new context rows.
ALTER TABLE public.jarvis_project_context REPLICA IDENTITY FULL;

-- Keep last_updated_at honest. The cole-write-context endpoint always sets
-- last_updated_at = now() on upsert, so this trigger is defensive only — covers
-- ad-hoc UPDATEs from the dashboard or future endpoints.
CREATE OR REPLACE FUNCTION public.jarvis_project_context_touch()
RETURNS trigger AS $$
BEGIN
  IF NEW.last_updated_at IS NULL OR NEW.last_updated_at = OLD.last_updated_at THEN
    NEW.last_updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jarvis_project_context_touch ON public.jarvis_project_context;
CREATE TRIGGER trg_jarvis_project_context_touch
  BEFORE UPDATE ON public.jarvis_project_context
  FOR EACH ROW EXECUTE FUNCTION public.jarvis_project_context_touch();
