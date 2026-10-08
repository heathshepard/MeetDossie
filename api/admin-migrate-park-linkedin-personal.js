// One-time migration for
// supabase/migrations/20260930c_park_linkedin_personal.sql — see that file
// for the full incident writeup. Runs the entire migration (constraint
// widen + backlog park + ops_flags seed) through the same direct-Postgres
// connection every admin-migrate-*.js route uses, since PostgREST
// (SUPABASE_URL) cannot run DDL and the constraint-widening step must land
// before the UPDATE that depends on it.
//
// Safe to re-run — DROP-then-CREATE constraint, ON CONFLICT DO NOTHING on
// the ops_flags insert, and the UPDATE only ever touches rows still in
// status='approved' (a second run is a no-op once the first has parked
// them).
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
    'image_mismatch_hold', 'video_failed', 'parked_no_account'
  ));

COMMENT ON CONSTRAINT social_posts_status_check ON public.social_posts IS
  'parked_no_account added 2026-09-30 — content is approved/fine but its platform has no wired posting_schedule/zernio_accounts destination yet (see 20260930c_park_linkedin_personal.sql). Restorable to approved once the destination is connected.';

UPDATE public.social_posts
SET
  status = 'parked_no_account',
  error_message = 'PARKED 2026-09-30 (Atlas): linkedin_personal has no posting_schedule row and no zernio_accounts row -- this post can never publish as-is. It was intended for Heath''s realtor LinkedIn page, which has never been connected to Zernio. Content preserved; restorable to approved once that connection exists. See ops_flags.generate_heath_linkedin_personal.'
WHERE platform = 'linkedin_personal' AND status = 'approved';

INSERT INTO public.ops_flags (key, enabled, reason, updated_by) VALUES
  ('generate_heath_linkedin_personal', FALSE,
   'PARKED 2026-09-30 (Atlas): linkedin_personal was intended for Heath''s own realtor LinkedIn page, which has never been connected to Zernio (no posting_schedule row, no zernio_accounts row) -- every post generated here queues forever and can never publish. api/cron-generate-heath-linkedin.js checks this flag before generating and no-ops while it is off. UNPARK: connect Heath''s realtor LinkedIn to Zernio, add a posting_schedule row and a zernio_accounts row for platform=linkedin_personal/owner=heath-realtor (or whatever owner key is chosen), restore the parked backlog (see 20260930c_park_linkedin_personal.sql), then flip this flag TRUE.',
   'migration:20260930c_park_linkedin_personal')
ON CONFLICT (key) DO NOTHING;
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
      message: "linkedin_personal parked: social_posts_status_check allows 'parked_no_account', backlog moved, ops_flags.generate_heath_linkedin_personal seeded OFF",
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to run park-linkedin-personal migration',
      details: err.message,
    });
  }
};
