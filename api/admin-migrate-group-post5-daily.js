'use strict';

// One-time migration: add pipeline/group_key/hook_type/content_hash columns
// to public.group_posts for the daily 5-group-post pipeline. Safe to re-run
// — IF NOT EXISTS throughout, no data touched.
//
// DDL isn't reachable through PostgREST — runs directly against Postgres via
// api/_lib/pg-admin.js. Mirrors supabase/migrations/20260909_group_post5_daily.sql
// and the exact pattern of api/admin-migrate-comment-opportunities.js. Local
// POSTGRES_* env is write-only ([SENSITIVE]) so this can only run from a
// deployed environment:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://<preview-or-prod>/api/admin-migrate-group-post5-daily
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-09

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.group_posts
  ADD COLUMN IF NOT EXISTS pipeline TEXT DEFAULT NULL;

ALTER TABLE public.group_posts
  ADD COLUMN IF NOT EXISTS group_key TEXT DEFAULT NULL;

ALTER TABLE public.group_posts
  ADD COLUMN IF NOT EXISTS hook_type TEXT DEFAULT NULL;

ALTER TABLE public.group_posts
  ADD COLUMN IF NOT EXISTS content_hash TEXT
  GENERATED ALWAYS AS (md5(btrim(regexp_replace(post_body, '\\s+', ' ', 'g')))) STORED;

CREATE INDEX IF NOT EXISTS idx_group_posts_daily5_group_recent
  ON public.group_posts (group_key, created_at)
  WHERE pipeline = 'daily5';

CREATE INDEX IF NOT EXISTS idx_group_posts_daily5_status
  ON public.group_posts (pipeline, status)
  WHERE pipeline = 'daily5';

COMMENT ON COLUMN public.group_posts.pipeline IS
  'NULL = legacy group_registry rotation campaign. ''daily5'' = the 5-group daily pipeline (api/_lib/daily-group5-post-generator.js). Keeps the two group_posts producers/consumers from ever selecting each other''s rows.';
COMMENT ON COLUMN public.group_posts.group_key IS
  'Matches the "key" field in scripts/comment-hunt-groups.json for daily5 rows (e.g. dfw_network_collab). NULL for legacy rows, which key off group_registry_id instead.';
COMMENT ON COLUMN public.group_posts.hook_type IS
  'daily5 only: which content format generated this post (ask_advice/founder_story/contrarian/teardown/resource_giveaway). Used for near-duplicate-hook dedupe.';
COMMENT ON COLUMN public.group_posts.content_hash IS
  'Generated column: md5 of whitespace-normalized post_body. Exact-duplicate dedupe layer for the daily5 pipeline.';
`;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    await runAdminSql(SQL);
    return res.status(200).json({ ok: true, migrated: 'group_posts pipeline/group_key/hook_type/content_hash columns' });
  } catch (err) {
    console.error('[admin-migrate-group-post5-daily]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
