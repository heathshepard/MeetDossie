// One-time migration: create public.cancellation_feedback. Full design
// commentary in supabase/migrations/20260824190000_cancellation_feedback.sql.
//
// Safe to re-run — CREATE TABLE IF NOT EXISTS, no data touched.
//
// This route exists because POSTGRES_URL_NON_POOLING is a write-only
// ("Sensitive") Vercel var, so DDL cannot be run from a local shell — same
// reason the admin-migrate-* siblings exist (e.g.
// admin-migrate-compliance-vault-addon.js).
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-08-24 (cancel-subscription exit-survey rebuild)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
CREATE TABLE IF NOT EXISTS public.cancellation_feedback (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email                       TEXT,
  reason                      TEXT,
  reason_detail               TEXT,
  what_would_have_kept_them   TEXT,
  subscription_cancelled      BOOLEAN NOT NULL DEFAULT false,
  cancelled_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.cancellation_feedback IS
  'Exit-survey answers submitted from the Settings > Billing > Cancel Subscription flow. One row per cancel attempt (regardless of whether the Stripe cancellation itself succeeded). Read directly by Heath — also relayed live via the Telegram cancellation notification in api/cancel-subscription.js.';

CREATE INDEX IF NOT EXISTS idx_cancellation_feedback_user
  ON public.cancellation_feedback (user_id, cancelled_at DESC);

ALTER TABLE public.cancellation_feedback ENABLE ROW LEVEL SECURITY;
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
      message: 'cancellation_feedback table ready',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({ ok: false, error: 'Failed to create cancellation_feedback table', details: err.message });
  }
};
