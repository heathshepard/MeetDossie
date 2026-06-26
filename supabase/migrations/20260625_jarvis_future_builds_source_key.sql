-- 20260625_jarvis_future_builds_source_key.sql
-- Atlas reconciler: add source_key to jarvis_future_builds for idempotent UPSERTs
-- 2026-06-25
--
-- Format: "<source>:<id>" — e.g., github:branch-name, github-pr:#123,
-- memory:project_xyz, dod:filename.md, heath-queue:<uuid>, manual:<random>.
--
-- Existing hand-seeded rows are backfilled with manual:<short_uuid> so the
-- composite UNIQUE constraint can land without conflicts.

ALTER TABLE public.jarvis_future_builds
  ADD COLUMN IF NOT EXISTS source_key text;

-- Backfill hand-seeded rows with a deterministic manual key.
UPDATE public.jarvis_future_builds
  SET source_key = 'manual:' || substring(id::text, 1, 8)
  WHERE source_key IS NULL;

-- Hard NOT NULL: reconciler always sets source_key on insert.
ALTER TABLE public.jarvis_future_builds
  ALTER COLUMN source_key SET NOT NULL;

-- Composite UNIQUE per tenant. Drop any prior partial index first.
DROP INDEX IF EXISTS idx_jarvis_future_builds_source_key_uniq;

ALTER TABLE public.jarvis_future_builds
  DROP CONSTRAINT IF EXISTS jarvis_future_builds_tenant_source_key_uniq;

ALTER TABLE public.jarvis_future_builds
  ADD CONSTRAINT jarvis_future_builds_tenant_source_key_uniq
  UNIQUE (tenant_id, source_key);

COMMENT ON COLUMN public.jarvis_future_builds.source_key IS
  'Canonical source identifier for reconciler UPSERTs. Format: <source>:<id>. e.g., github:branch-name, github-pr:#123, memory:project_xyz, dod:filename.md, heath-queue:uuid, manual:randomsuffix.';
