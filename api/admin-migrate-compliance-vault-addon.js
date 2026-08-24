// One-time migration: add subscriptions.compliance_vault_enabled +
// subscriptions.compliance_vault_stripe_sub_id. Full design commentary in
// supabase/migrations/20260824_compliance_vault_addon.sql.
//
// Safe to re-run — ADD COLUMN IF NOT EXISTS, no data touched.
//
// This route exists because POSTGRES_URL_NON_POOLING is a write-only
// ("Sensitive") Vercel var, so DDL cannot be run from a local shell — the
// pulled value is the literal [SENSITIVE]. Same reason the admin-migrate-*
// siblings exist (e.g. admin-migrate-email-integration-addon.js).
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-08-24 (Compliance Vault add-on for Solo)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS compliance_vault_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS compliance_vault_stripe_sub_id TEXT;

COMMENT ON COLUMN subscriptions.compliance_vault_enabled IS
  'Compliance Vault add-on ($15/mo, $7.50/mo founding) entitlement for Solo agents. Gates api/solo-documents.js.';
COMMENT ON COLUMN subscriptions.compliance_vault_stripe_sub_id IS
  'Stripe subscription id for the Compliance Vault add-on specifically. NULL when enabled by hand.';
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
      message: 'compliance_vault_enabled + compliance_vault_stripe_sub_id columns ready',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({ ok: false, error: 'Failed to migrate compliance_vault addon columns', details: err.message });
  }
};
