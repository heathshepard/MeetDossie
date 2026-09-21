'use strict';

// One-time migration: create public.member_memory + its search/dedupe RPCs.
// Full design commentary in supabase/migrations/20260921_member_memory.sql —
// keep the two in sync; this is the inline copy DDL actually runs from
// (POSTGRES_URL_NON_POOLING is a write-only Vercel var, so DDL can't run
// from a local shell — same reason every admin-migrate-*.js sibling exists).
//
// Safe to re-run — every statement is IF NOT EXISTS / OR REPLACE / a
// DROP POLICY|TRIGGER-then-CREATE pair.
//
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://<preview-or-prod>/api/admin-migrate-member-memory
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-21

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
CREATE TABLE IF NOT EXISTS public.member_memory (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  category      TEXT NOT NULL DEFAULT 'other' CHECK (category IN (
                  'preference', 'workflow', 'communication_style', 'contact',
                  'financial_fact', 'deal_fact', 'other'
                )),
  title         TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  content       TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),

  source        TEXT NOT NULL CHECK (source IN ('inferred', 'stated', 'confirmed')),
  status        TEXT NOT NULL DEFAULT 'pending_confirmation' CHECK (status IN (
                  'active', 'pending_confirmation', 'retired'
                )),

  embedding     VECTOR(1536),
  usage_count   INT NOT NULL DEFAULT 0,
  last_used_at  TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

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

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'jarvis_touch_updated_at') THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_member_memory_updated_at ON public.member_memory';
    EXECUTE 'CREATE TRIGGER trg_member_memory_updated_at
             BEFORE UPDATE ON public.member_memory
             FOR EACH ROW EXECUTE FUNCTION public.jarvis_touch_updated_at()';
  ELSE
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
END$do$;

ALTER TABLE public.member_memory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS member_memory_owner_all ON public.member_memory;
CREATE POLICY member_memory_owner_all ON public.member_memory
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.member_memory IS
  'Per-subscriber memory for Dossie chat. source=inferred entries are trusted immediately; source=stated entries start status=pending_confirmation and are excluded from recall until the member confirms them. Never derive user_id from a request body or tool parameter.';

CREATE OR REPLACE FUNCTION public.member_memory_search(
  p_user_id         UUID,
  p_query_embed     VECTOR(1536),
  p_match_threshold DOUBLE PRECISION DEFAULT 0.40,
  p_match_count     INT DEFAULT 12
)
RETURNS TABLE (
  id UUID, category TEXT, title TEXT, content TEXT, source TEXT,
  usage_count INT, created_at TIMESTAMPTZ, similarity DOUBLE PRECISION
)
LANGUAGE sql
STABLE
AS $fn$
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
$fn$;

REVOKE EXECUTE ON FUNCTION public.member_memory_search(UUID, VECTOR, DOUBLE PRECISION, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.member_memory_search(UUID, VECTOR, DOUBLE PRECISION, INT) FROM anon;

CREATE OR REPLACE FUNCTION public.member_memory_find_duplicate(
  p_user_id     UUID,
  p_category    TEXT,
  p_query_embed VECTOR(1536),
  p_threshold   DOUBLE PRECISION DEFAULT 0.92
)
RETURNS TABLE (id UUID, status TEXT, similarity DOUBLE PRECISION, usage_count INT)
LANGUAGE sql
STABLE
AS $fn$
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
$fn$;

REVOKE EXECUTE ON FUNCTION public.member_memory_find_duplicate(UUID, TEXT, VECTOR, DOUBLE PRECISION) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.member_memory_find_duplicate(UUID, TEXT, VECTOR, DOUBLE PRECISION) FROM anon;
`;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    await runAdminSql(SQL);
    return res.status(200).json({
      ok: true,
      migrated: 'public.member_memory created with RLS (owner-only) + member_memory_search/find_duplicate RPCs (PUBLIC/anon EXECUTE revoked)',
    });
  } catch (err) {
    console.error('[admin-migrate-member-memory]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
