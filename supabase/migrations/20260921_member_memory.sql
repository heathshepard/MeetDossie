-- MEMBER MEMORY — Dossie's per-subscriber memory store.
--
-- Heath, 2026-09-21: "each subscriber needs their own memory so their own
-- dossie will learn their preferences and files." Before this, api/chat.js
-- read no memory store at all (verified: zero references) — every
-- conversation started cold.
--
-- Mirrors the pattern already in production for Heath's internal agents
-- (public.agent_role_memory, supabase/migrations/20260622_agent_role_memory.sql)
-- — pgvector embedding, ivfflat cosine index, usage_count + last_used_at —
-- but keyed on the MEMBER (user_id), not an agent role, and with a stricter
-- write gate: not everything Dossie notices may be silently remembered.
--
-- THE SOURCE / STATUS SPLIT — Heath's distinction, not negotiable:
--   * Preferences / workflow habits (preferred title company, typical option
--     fee, "net sheet before offer summary") may be inferred silently from
--     repeated behavior: source='inferred', status='active' immediately.
--   * Stated facts about people, money, or files (a payoff amount, a lender,
--     a client deadline) may NEVER be silently learned: source='stated',
--     status='pending_confirmation'. api/chat.js's load step (searchMemory)
--     only ever returns status='active' rows, so a pending fact is
--     mechanically incapable of being reused in a reply until the member
--     confirms it (which flips source->'confirmed', status->'active') or
--     rejects it (status->'retired'). A confidently-reused wrong fact is
--     worse than no memory — Heath's own standing rule on conflicting data:
--     surface it, let the member choose, then act.
--
-- SECURITY. This table holds one member's private preferences and facts
-- about their own clients/files. Per the 2026-09-17 impersonation/RLS
-- incident (security-mt-acting-user-impersonation-2026-09-17), user_id is
-- NEVER trusted from a request body or tool parameter anywhere that reads or
-- writes this table — every API route in api/_lib/member-memory.js and
-- api/member-memory-*.js derives it from verifySupabaseToken(req) only.
-- RLS is enabled from this same migration, not added later, and no function
-- here is SECURITY DEFINER, so there is nothing to accidentally grant to
-- PUBLIC/anon the way the September functions were.

CREATE TABLE IF NOT EXISTS public.member_memory (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  category      TEXT NOT NULL DEFAULT 'other' CHECK (category IN (
                  'preference',            -- title company, option terms, workflow order
                  'workflow',               -- "always send net sheet before offer summary"
                  'communication_style',    -- email tone, formality
                  'contact',                -- a person's role/contact info the member mentioned
                  'financial_fact',         -- a payoff, a rate, a fee amount
                  'deal_fact',              -- a client/file-specific fact not on the dossier record
                  'other'
                )),
  title         TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  content       TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),

  source        TEXT NOT NULL CHECK (source IN ('inferred', 'stated', 'confirmed')),
  status        TEXT NOT NULL DEFAULT 'pending_confirmation' CHECK (status IN (
                  'active', 'pending_confirmation', 'retired'
                )),

  embedding     VECTOR(1536),             -- OpenAI text-embedding-3-small; nullable, backfilled async
  usage_count   INT NOT NULL DEFAULT 0,
  last_used_at  TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- An inferred entry is trusted the moment it's written, so it may never
  -- start life pending — only a stated/unconfirmed fact goes through review.
  CONSTRAINT member_memory_inferred_is_active CHECK (
    source <> 'inferred' OR status <> 'pending_confirmation'
  )
);

CREATE INDEX IF NOT EXISTS member_memory_user_status_idx
  ON public.member_memory (user_id, status);
CREATE INDEX IF NOT EXISTS member_memory_user_recent_idx
  ON public.member_memory (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS member_memory_embedding_cosine_idx
  ON public.member_memory USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'jarvis_touch_updated_at') THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_member_memory_updated_at ON public.member_memory';
    EXECUTE 'CREATE TRIGGER trg_member_memory_updated_at
             BEFORE UPDATE ON public.member_memory
             FOR EACH ROW EXECUTE FUNCTION public.jarvis_touch_updated_at()';
  ELSE
    -- Fallback trigger if the jarvis helper isn't present on this project.
    EXECUTE $t$
      CREATE OR REPLACE FUNCTION public.member_memory_touch_updated_at()
      RETURNS TRIGGER LANGUAGE plpgsql AS $f$
      BEGIN
        NEW.updated_at := NOW();
        RETURN NEW;
      END;
      $f$;
    $t$;
    EXECUTE 'DROP TRIGGER IF EXISTS trg_member_memory_updated_at ON public.member_memory';
    EXECUTE 'CREATE TRIGGER trg_member_memory_updated_at
             BEFORE UPDATE ON public.member_memory
             FOR EACH ROW EXECUTE FUNCTION public.member_memory_touch_updated_at()';
  END IF;
END$$;

-- Row Level Security — owner-only, enabled from this same migration.
-- Every API route also uses the service-role key (which bypasses RLS, same
-- as seller_intake / documents / transactions) and independently filters by
-- the verified session's user_id, so this is defense in depth: a client that
-- ever queried with the anon/authenticated key directly still could not read
-- or write another member's rows.
ALTER TABLE public.member_memory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS member_memory_owner_all ON public.member_memory;
CREATE POLICY member_memory_owner_all ON public.member_memory
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.member_memory IS
  'Per-subscriber memory for Dossie chat. source=inferred entries are trusted immediately; source=stated entries start status=pending_confirmation and are excluded from recall until the member confirms them via the member memory view. Never derive user_id from a request body or tool parameter — see the header of api/_lib/member-memory.js.';

-- ----------------------------------------------------------------------------
-- Semantic search RPC — mirrors agent_memory_search but user-scoped and only
-- ever returns status='active' rows, which is the mechanical enforcement of
-- "a pending fact is never reused before confirmation."
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.member_memory_search(
  p_user_id         UUID,
  p_query_embed     VECTOR(1536),
  p_match_threshold DOUBLE PRECISION DEFAULT 0.40,
  p_match_count     INT DEFAULT 12
)
RETURNS TABLE (
  id           UUID,
  category     TEXT,
  title        TEXT,
  content      TEXT,
  source       TEXT,
  usage_count  INT,
  created_at   TIMESTAMPTZ,
  similarity   DOUBLE PRECISION
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    m.id, m.category, m.title, m.content, m.source, m.usage_count, m.created_at,
    (1 - (m.embedding <=> p_query_embed))::DOUBLE PRECISION AS similarity
  FROM public.member_memory m
  WHERE m.user_id = p_user_id
    AND m.status = 'active'
    AND m.embedding IS NOT NULL
    AND (1 - (m.embedding <=> p_query_embed)) >= p_match_threshold
  ORDER BY similarity DESC, m.usage_count DESC, m.created_at DESC
  LIMIT GREATEST(p_match_count, 1);
$$;

-- Functions created with no explicit GRANT default to PUBLIC EXECUTE in
-- Postgres — the exact class of hole found 2026-09-17
-- (security-mt-acting-user-impersonation-2026-09-17: 19 SECURITY DEFINER
-- functions granted to anon/PUBLIC). This function is plain SQL (not
-- SECURITY DEFINER) so it only ever runs with the CALLER's own privileges —
-- but the caller here is always the service-role key from
-- api/_lib/member-memory.js, never a browser-held anon/authenticated key, so
-- there is no legitimate reason for PUBLIC or anon to be able to invoke it
-- directly. Revoke explicitly rather than relying on that being enough.
REVOKE EXECUTE ON FUNCTION public.member_memory_search(UUID, VECTOR, DOUBLE PRECISION, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.member_memory_search(UUID, VECTOR, DOUBLE PRECISION, INT) FROM anon;

-- ----------------------------------------------------------------------------
-- Dedupe RPC — same shape as agent_memory_find_duplicate, user-scoped.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.member_memory_find_duplicate(
  p_user_id     UUID,
  p_category    TEXT,
  p_query_embed VECTOR(1536),
  p_threshold   DOUBLE PRECISION DEFAULT 0.92
)
RETURNS TABLE (
  id          UUID,
  status      TEXT,
  similarity  DOUBLE PRECISION,
  usage_count INT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    m.id, m.status,
    (1 - (m.embedding <=> p_query_embed))::DOUBLE PRECISION AS similarity,
    m.usage_count
  FROM public.member_memory m
  WHERE m.user_id = p_user_id
    AND m.category = p_category
    AND m.status <> 'retired'
    AND m.embedding IS NOT NULL
    AND (1 - (m.embedding <=> p_query_embed)) >= p_threshold
  ORDER BY m.embedding <=> p_query_embed
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.member_memory_find_duplicate(UUID, TEXT, VECTOR, DOUBLE PRECISION) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.member_memory_find_duplicate(UUID, TEXT, VECTOR, DOUBLE PRECISION) FROM anon;
