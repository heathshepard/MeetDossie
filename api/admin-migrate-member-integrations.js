// One-time migration: per-member DocuSeal + health-cache columns on
// public.user_integrations, and the Connections wizard flag on
// public.profiles. Canonical SQL + column commentary:
// api/_migrations/0027-member-integrations.sql.
//
// Safe to re-run — ADD COLUMN IF NOT EXISTS / guarded constraint add only.
// No data is touched.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-10-01 (member integrations + setup wizard build)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.user_integrations ADD COLUMN IF NOT EXISTS docuseal_api_key_encrypted TEXT;
ALTER TABLE public.user_integrations ADD COLUMN IF NOT EXISTS docuseal_account_email TEXT;
ALTER TABLE public.user_integrations ADD COLUMN IF NOT EXISTS last_check_status TEXT;
ALTER TABLE public.user_integrations ADD COLUMN IF NOT EXISTS last_check_detail TEXT;
ALTER TABLE public.user_integrations ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_integrations_last_check_status_check'
  ) THEN
    ALTER TABLE public.user_integrations
      ADD CONSTRAINT user_integrations_last_check_status_check
      CHECK (last_check_status IS NULL OR last_check_status IN (
        'connected', 'expired', 'error', 'never_connected'
      ));
  END IF;
END $$;

COMMENT ON COLUMN public.user_integrations.docuseal_api_key_encrypted IS
  'AES-256-GCM-encrypted DocuSeal API key for oauth_provider=docuseal rows
   (api/_lib/secret-crypto.js). Never plaintext, never logged. Written by
   api/integrations-docuseal-connect.js only after a live validation call
   confirms the key actually authenticates.';
COMMENT ON COLUMN public.user_integrations.docuseal_account_email IS
  'Best-effort label for the connected DocuSeal account, shown in the
   Connections UI.';
COMMENT ON COLUMN public.user_integrations.last_check_status IS
  'Cached outcome of the most recent on-demand health check
   (api/integrations-check.js): connected/expired/error/never_connected.';
COMMENT ON COLUMN public.user_integrations.last_check_detail IS
  'Human-readable reason for the last_check_status, safe to show a member.';

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS connections_wizard_completed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS connections_wizard_completed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.profiles.connections_wizard_completed IS
  'True once the member has clicked through (or explicitly skipped) the
   Connections setup wizard (Email + DocuSeal).';
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
      message: 'user_integrations DocuSeal/health columns + profiles.connections_wizard_completed ready',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({ ok: false, error: 'Failed to migrate member-integrations columns', details: err.message });
  }
};
