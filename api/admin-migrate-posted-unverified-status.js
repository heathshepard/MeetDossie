// One-time migration for
// supabase/migrations/20260930d_social_posts_posted_unverified_status.sql —
// see that file for the full incident writeup. Widens social_posts'
// status check constraint to allow 'posted_unverified' through the same
// direct-Postgres connection every admin-migrate-*.js route uses, since
// PostgREST (SUPABASE_URL) cannot run DDL.
//
// Safe to re-run — DROP-then-CREATE constraint is idempotent.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-09-30

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.social_posts DROP CONSTRAINT IF EXISTS social_posts_status_check;

ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_status_check
  CHECK (status IN (
    'draft', 'approved', 'publishing', 'posted', 'failed', 'pending_video', 'rejected',
    'image_mismatch_hold', 'video_failed', 'parked_no_account', 'posted_unverified'
  ));

COMMENT ON CONSTRAINT social_posts_status_check ON public.social_posts IS
  'posted_unverified added 2026-09-30 — Zernio returned a 2xx with no extractable post identifier. Distinct from posted (verified survival) and failed (Zernio rejected the request). See 20260930d_social_posts_posted_unverified_status.sql.';
`;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(SQL);
    return res.status(200).json({
      ok: true,
      message: "social_posts_status_check now allows 'posted_unverified'",
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to run posted-unverified-status migration',
      details: err.message,
    });
  }
};
