// One-time migration: subscriptions.trial_start / trial_end columns.
// See supabase/migrations/20260926_trial_fields.sql for the full design
// commentary.
//
// URGENT (Atlas, 2026-09-28, post-merge gap found): feature/free-trial-
// checkout-0926 shipped the .sql migration file but never shipped an
// endpoint to apply it. api/complete-onboarding.js's upsertSubscriptionBySubId
// unconditionally includes trial_start/trial_end keys in every onboarding
// upsert (not gated on TRIAL_DAYS) — with the columns missing, PostgREST
// rejects that write with an undefined-column error, which complete-
// onboarding.js's outer catch turns into a hard 500 to the customer
// completing onboarding. This endpoint closes that gap; run it before any
// real signup completes onboarding.
//
// Safe to re-run — ADD COLUMN IF NOT EXISTS, no data touched.
//
// This route exists because POSTGRES_URL_NON_POOLING is a write-only
// ("Sensitive") Vercel var, so DDL cannot be run from a local shell -- the
// pulled value is the literal [SENSITIVE]. Same reason the admin-migrate-*
// siblings exist.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-09-28

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS trial_start TIMESTAMPTZ;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS trial_end TIMESTAMPTZ;

COMMENT ON COLUMN public.subscriptions.trial_start IS
  'Stripe subscription.trial_start, mirrored on checkout.session.completed / customer.subscription.created / customer.subscription.updated / complete-onboarding. NULL for subscriptions created with no trial (TRIAL_DAYS=0) or before this column existed.';

COMMENT ON COLUMN public.subscriptions.trial_end IS
  'Stripe subscription.trial_end, mirrored the same way as trial_start. Used by api/cron-trial-conversion-watch.js to distinguish a trial that has not ended yet from one that ended without converting to active.';
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
      message: 'subscriptions.trial_start / trial_end columns added',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to apply trial-fields migration',
      details: err.message,
    });
  }
};
