// One-time migration: replace the PARTIAL unique index
// idx_post_analytics_video_per_day (video_library_id, sync_date) WHERE
// video_library_id IS NOT NULL -- created by
// 20260930_post_analytics_owner_attribution.sql -- with a plain unique
// index on the same two columns.
//
// WHY (Atlas, 2026-10-09 -- analytics-sync-video-link task): confirmed
// live that every video_library post_analytics upsert 400'd with
// Postgres error 42P10 ("there is no unique or exclusion constraint
// matching the ON CONFLICT specification"). PostgREST's
// on_conflict=video_library_id,sync_date generates a plain
// ON CONFLICT (video_library_id, sync_date) clause with no WHERE
// predicate, which Postgres cannot match against a partial index.
// A plain unique index behaves identically here -- NULLs are never
// treated as equal in a unique index, so social_posts rows
// (video_library_id always NULL) still never collide with each other.
// See supabase/migrations/20261009_post_analytics_video_unique_fix.sql
// for the full writeup.
//
// Safe to re-run -- DROP INDEX IF EXISTS / CREATE UNIQUE INDEX IF NOT
// EXISTS, no data touched.
//
// NOT INVOKED as part of this branch/PR — changes the live production
// database immediately regardless of git branch/merge state. Trigger
// deliberately:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://meetdossie.com/api/admin-migrate-post-analytics-video-unique-fix
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-10-09

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
DROP INDEX IF EXISTS public.idx_post_analytics_video_per_day;

CREATE UNIQUE INDEX IF NOT EXISTS idx_post_analytics_video_per_day
  ON public.post_analytics (video_library_id, sync_date);
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
      message: 'idx_post_analytics_video_per_day rebuilt as a plain (non-partial) unique index',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to rebuild idx_post_analytics_video_per_day',
      details: err.message,
    });
  }
};
