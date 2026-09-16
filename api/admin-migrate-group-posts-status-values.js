'use strict';

// One-time migration: widen group_posts_status_check to allow the two new
// terminal statuses scripts/fb-group-poster.js now writes -- identity_rejected
// and not_a_member (per-group truth audit, 2026-09-16). See
// supabase/migrations/20260916_group_posts_status_check_widen.sql.
//
// NOTE: the exact current constraint definition could not be introspected
// from this session (no working direct-Postgres credential locally -- see
// docs/ENV.md, POSTGRES_URL_NON_POOLING is write-only with no vault backup).
// The allowed-value list below was inferred from every status value
// actually observed live in group_posts (draft, approved, posted, rejected,
// pending_admin_approval, blocked_group_rules, skipped, failed) plus the
// two new ones. Sanity-check group_posts.status distribution after running
// this if anything looks off.
//
// DDL isn't reachable through PostgREST — runs directly against Postgres via
// api/_lib/pg-admin.js, same pattern as every other admin-migrate-*.js:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://<preview-or-prod>/api/admin-migrate-group-posts-status-values
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-16

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.group_posts
  DROP CONSTRAINT IF EXISTS group_posts_status_check;

ALTER TABLE public.group_posts
  ADD CONSTRAINT group_posts_status_check
    CHECK (status IN (
      'draft',
      'approved',
      'posted',
      'rejected',
      'pending_admin_approval',
      'blocked_group_rules',
      'skipped',
      'failed',
      'identity_rejected',
      'not_a_member'
    ));
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
      message: 'group_posts_status_check widened to allow identity_rejected, not_a_member',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to migrate group_posts',
      detail: err.message,
    });
  }
};
