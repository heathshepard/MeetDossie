// One-time migration: add linkedin_publish_attempts to social_posts for the
// LinkedIn personal-post publish dead-letter fix. Mirrors
// supabase/migrations/20260912b_social_posts_linkedin_publish_dead_letter.sql
// and the exact pattern of api/admin-migrate-image-mismatch-hold-status.js.
//
// DDL isn't reachable through PostgREST, so this runs directly against
// Postgres via api/_lib/pg-admin.js (POSTGRES_URL_NON_POOLING).
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-12

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS linkedin_publish_attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.social_posts.linkedin_publish_attempts IS
  'Number of times linkedin-engager.js postApprovedLinkedIn() has attempted (and failed) to publish this row. At 3, status flips to failed and the row is permanently skipped so it can never block newer approved rows again.';
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
      message: 'linkedin_publish_attempts column added to social_posts',
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
