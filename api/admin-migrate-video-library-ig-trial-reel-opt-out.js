// One-time migration for
// supabase/migrations/20261005_video_library_ig_trial_reel_opt_out.sql — see
// that file for the full writeup. Adds video_library.ig_trial_reel_opt_out
// through the same direct-Postgres connection every admin-migrate-*.js route
// uses, since PostgREST (SUPABASE_URL) cannot run DDL.
//
// Safe to re-run — ADD COLUMN IF NOT EXISTS is idempotent.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-10-05

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.video_library
  ADD COLUMN IF NOT EXISTS ig_trial_reel_opt_out boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.video_library.ig_trial_reel_opt_out IS
  'Per-row opt-out from the default Instagram Trial Reel behavior (api/cron-post-videos.js postToZernio()). Trial Reels are ON by default for target_owner=''dossie'' Instagram posts -- set this TRUE to publish as a normal Reel instead. Never applies to owner=''heath-realtor'' (982 followers already -- Trial Reels solve a cold-start problem that account does not have).';
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
      message: 'video_library.ig_trial_reel_opt_out added (default false — Trial Reels on by default for owner=dossie Instagram posts)',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to run ig-trial-reel-opt-out migration',
      details: err.message,
    });
  }
};
