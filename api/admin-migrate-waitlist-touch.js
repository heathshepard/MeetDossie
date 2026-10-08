// One-time migration: add first_touch/last_touch jsonb to public.waitlist so
// the two live lead magnets (source='trec-deadline-checklist'/
// 'trec-para12-breakdown') and the TREC calculator can answer "which post
// produced this lead" the same way founding_applications/subscriptions
// already do. See
// supabase/migrations/20261002_waitlist_first_last_touch.sql for the full
// rationale. Safe to re-run — IF NOT EXISTS, no data destroyed, no existing
// row touched.
//
// NOT INVOKED as part of this branch/PR — this changes the live production
// database immediately regardless of git branch/merge state, so it is left
// for Heath to trigger deliberately:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://meetdossie.com/api/admin-migrate-waitlist-touch
//
// Mirrors api/admin-migrate-post-analytics-owner.js's exact pattern (DDL
// isn't reachable through PostgREST on this project, so this runs directly
// against Postgres via api/_lib/pg-admin.js).
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Pierce, 2026-10-02 (feat/lead-attribution-1002)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.waitlist
  ADD COLUMN IF NOT EXISTS first_touch JSONB,
  ADD COLUMN IF NOT EXISTS last_touch JSONB;
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
      message: 'waitlist.first_touch/last_touch added — lead-magnet attribution is now live (see api/_lib/attribution.js lead_magnet_signups_* fields).',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to migrate waitlist first_touch/last_touch',
      details: err.message,
    });
  }
};
