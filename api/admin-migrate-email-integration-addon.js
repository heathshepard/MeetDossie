// One-time migration: rename subscriptions.reply_monitoring_enabled to
// subscriptions.email_integration_enabled + add email_integration_stripe_sub_id.
// Full design commentary in supabase/migrations/20260822_email_integration_addon.sql.
//
// Safe to re-run: guards the rename with a column-existence check so a second
// run (after the column is already renamed) is a no-op instead of an error.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-08-22 (SV-ENG-EMAIL-INTEGRATION-ADDON)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions' AND column_name = 'reply_monitoring_enabled'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions' AND column_name = 'email_integration_enabled'
  ) THEN
    ALTER TABLE subscriptions RENAME COLUMN reply_monitoring_enabled TO email_integration_enabled;
  END IF;
END $$;

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS email_integration_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS email_integration_stripe_sub_id TEXT;

COMMENT ON COLUMN subscriptions.email_integration_enabled IS
  'Email Integration add-on ($15/mo, $7.50/mo founding) entitlement. Gates api/cron-email-to-dossier.js, api/cron-esign-events.js, api/cron-showingtime-feedback.js.';
COMMENT ON COLUMN subscriptions.email_integration_stripe_sub_id IS
  'Stripe subscription id for the Email Integration add-on specifically (distinct from the base-plan stripe_subscription_id on this same row). NULL when the add-on was enabled by hand.';
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
      message: 'email_integration_enabled column ready (renamed from reply_monitoring_enabled or created fresh); email_integration_stripe_sub_id added',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({ ok: false, error: 'Failed to migrate email_integration addon columns', details: err.message });
  }
};
