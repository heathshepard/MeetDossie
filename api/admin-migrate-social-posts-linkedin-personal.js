// One-time migration: widen public.social_posts_platform_check to allow
// platform='linkedin_personal'.
//
// Root cause of cron-generate-heath-linkedin persistent failure
// (error since 2026-08-14T11:03:08Z, http_502): the cron intentionally
// writes platform='linkedin_personal' (kept distinct from 'linkedin' so
// cron-publish-approved.js skips it -- no posting_schedule row for
// linkedin_personal; scripts/linkedin-engager.js publishes it manually via
// Playwright). No migration ever added that value to the check constraint,
// so every insert 400'd and the handler wrapped it as a 502. Not a vendor
// outage -- shipped code assumed a DB value that was never allowed.
//
// Safe to re-run -- DROP-then-CREATE constraint, no data touched.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-08-15

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.social_posts DROP CONSTRAINT IF EXISTS social_posts_platform_check;

ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_platform_check
  CHECK (platform IN ('facebook', 'instagram', 'linkedin', 'linkedin_personal', 'tiktok', 'twitter'));
`;

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader =
    (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(SQL);
    return res.status(200).json({
      ok: true,
      message: "social_posts_platform_check now allows 'linkedin_personal'",
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to widen social_posts_platform_check',
      details: err.message,
    });
  }
};
