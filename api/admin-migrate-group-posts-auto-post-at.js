'use strict';

// One-time migration: add the auto_post_at column to public.group_posts.
//
// ROOT CAUSE OF BUG 1 (2026-09-11): supabase/migrations/20260610000000_add_auto_post_at_to_group_posts.sql
// was written 2026-06-10 but never actually applied to the live database —
// no admin-migrate-*.js endpoint was ever created/run for it (unlike every
// other group_posts migration, e.g. api/admin-migrate-group-post5-daily.js).
// Every approve path that writes auto_post_at — the legacy group_approve_
// flow (api/group-post-callback.js), the daily5 flow (api/group5-post-callback.js,
// gp5_approve), the listing-groups flow (api/listing-group-post-callback.js,
// lst_approve), and both edit-reply approval paths in api/telegram-webhook.js —
// has been silently 400ing on every single approve tap since 2026-06-10
// (PostgREST PGRST204 "Could not find the 'auto_post_at' column"). The
// callback code never logged the failure, so Heath saw either a misleading
// "Already handled" toast or nothing at all, and no row ever left 'draft'.
//
// DDL isn't reachable through PostgREST — runs directly against Postgres via
// api/_lib/pg-admin.js. Mirrors supabase/migrations/20260610000000_add_auto_post_at_to_group_posts.sql,
// widened to IF NOT EXISTS so it's safe to re-run.
//
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://<preview-or-prod>/api/admin-migrate-group-posts-auto-post-at
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-11

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.group_posts
  ADD COLUMN IF NOT EXISTS auto_post_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_group_posts_auto_post_pending
  ON public.group_posts(auto_post_at)
  WHERE auto_post_at IS NOT NULL AND posted_at IS NULL;

COMMENT ON COLUMN public.group_posts.auto_post_at IS
  'Set on approve (any pipeline) to schedule autonomous posting. Read by scripts/poll-and-post-approved-groups.js and the local queue-runner scripts (auto_post_at IS NOT NULL AND posted_at IS NULL). Column existed only as an unapplied migration file from 2026-06-10 to 2026-09-11 -- every approve write against it 400d silently. See api/admin-migrate-group-posts-auto-post-at.js.';
`;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    await runAdminSql(SQL);
    return res.status(200).json({ ok: true, migrated: 'group_posts.auto_post_at column + index' });
  } catch (err) {
    console.error('[admin-migrate-group-posts-auto-post-at]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
